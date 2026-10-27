import { normalizeClientAddress, readServerEnv, timingSafeEqualText } from "../env.ts";
import { buildExport } from "./export-doc.ts";
import { autoParentId, beatOfColumn } from "./group.ts";
import { publicOrigin } from "./origin.ts";
import { createSessionRecord, listSessionRecords, readSessionRecord, secretMatches, type SessionRecord } from "./sessions.ts";
import { blobFailureClass, type CouncilStore } from "./store.ts";
import { defaultBoardCopy } from "./template.ts";
import {
  BODY_MAX,
  FIELD_MAX,
  HARVEST_MAX,
  HIRING_MAX,
  LABEL_MAX,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  STICKY_CAP,
  joinTarget,
  networkRateLimit,
  networkStickyCap,
  isAnonymousName,
  plainName,
  plainText,
  readSessionParam,
} from "./text.ts";
import type { Column, Dot, Meta, Point, RateDoc, Sticky, VoteDoc } from "./types.ts";
import { COLUMNS } from "./types.ts";

interface BoardFile {
  meta: Meta;
  stickies: Sticky[];
  votes: VoteDoc[];
  clients: Record<string, string>;
  rates: Record<string, RateDoc>;
}

const CREATOR_BODY_MAX = 16_384;

export interface CouncilDeps {
  store: CouncilStore;
  /** Plaintext key for fixture sessions listed in `sessions`. Production leaves this empty. */
  adminKey?: string;
  /** Site-wide secret that may create sessions. It is not an admin key. */
  creatorKey?: string;
  now: number;
  ip: string;
  createId?: () => string;
  /**
   * Fixture session ids that open without a registry record.
   * Omit this in production so only created sessions exist.
   */
  sessions?: readonly string[];
  /** Per-request cache. handleCouncil fills this so a poll reads the session once. */
  boards?: Map<string, BoardFile>;
  records?: Map<string, SessionRecord | null>;
}

/** Prefer Netlify's client IP. Otherwise the first X-Forwarded-For hop, never a later proxy. */
export function councilClientIp(netlifyIp: string | null, forwardedFor: string | null): string {
  const firstHop = forwardedFor?.split(",")[0]?.trim() ?? null;
  return normalizeClientAddress(netlifyIp, firstHop);
}

const HIRING = new Set<Column>(["pm", "designer", "channel"]);

export async function handleCouncil(request: Request, deps: CouncilDeps): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).slice(2);
  const method = request.method.toUpperCase();
  const scoped: CouncilDeps = { ...deps, boards: new Map(), records: new Map() };
  try {
    if (parts[0] === "sessions") return await catalog(request, scoped, method);
    const session = readSessionParam(url);
    if (!session) return json(400, { error: "invalid session" });
    const record = await loadRecord(scoped, session);
    const listed = scoped.sessions?.includes(session) ?? false;
    if (!record && !listed) return json(404, { error: "not found" });
    if (method === "GET" && parts[0] === "state") return await getState(request, scoped, session, url);
    if (method === "GET" && parts[0] === "export") return await exportSession(scoped, session, url);
    if (method === "POST" && parts[0] === "stickies" && parts.length === 1) return await createSticky(request, scoped, session);
    if (method === "PATCH" && parts[0] === "stickies" && parts[1]) return await patchSticky(request, scoped, session, parts[1]);
    if (method === "DELETE" && parts[0] === "stickies" && parts[1]) return await deleteSticky(request, scoped, session, parts[1]);
    if (method === "POST" && parts[0] === "votes") return await addVote(request, scoped, session);
    if (method === "DELETE" && parts[0] === "votes") return await undoVote(request, scoped, session);
    if (method === "GET" && parts[0] === "admin" && parts.length === 1) return adminCheck(scoped, session, url);
    if (method === "POST" && parts[0] === "admin") return await admin(request, scoped, session, url);
    if (method === "GET" && parts.length === 0) return json(200, { ok: true, sessionId: session });
    return json(404, { error: "not found" });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(`council failed ${blobFailureClass(error)}`);
    return json(500, { error: "council failed" });
  }
}

export function adminAllowed(provided: string | null, expected: string): boolean {
  if (!expected) return false;
  return timingSafeEqualText(provided ?? "", expected);
}

/** Cheap key check. The body is only { ok }, never the key that was sent. */
async function adminCheck(deps: CouncilDeps, session: string, url: URL): Promise<Response> {
  const ok = await isAdmin(deps, session, url.searchParams.get("admin") ?? url.searchParams.get("k"));
  return json(ok ? 200 : 403, { ok });
}

async function getState(request: Request, deps: CouncilDeps, session: string, url: URL): Promise<Response> {
  const admin = await isAdmin(deps, session, url.searchParams.get("admin") ?? url.searchParams.get("k"));
  const participant = url.searchParams.get("p");
  const board = await loadBoard(deps, session);
  const record = await loadRecord(deps, session);
  const counts = countVotes(board.votes);
  const mine = board.votes.find((vote) => vote.participantId === participant);
  const visible = board.stickies.filter((sticky) => !sticky.hidden);
  const copy = record?.content ?? defaultBoardCopy();
  const payload = JSON.stringify({
    sessionId: session,
    admin,
    content: {
      title: copy.title,
      shortName: copy.shortName,
      waiting: copy.waiting,
      columns: copy.columns,
      beats: copy.beats,
      framing: copy.framing,
    },
    phones: phoneCount(board.stickies, board.votes),
    meta: {
      beat: board.meta.beat,
      voteOpen: board.meta.voteOpen,
      revealed: board.meta.revealed,
      arrowsOn: board.meta.arrowsOn,
      locked: board.meta.locked,
    },
    stickies: visible
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((sticky) => presentSticky(sticky, counts.get(sticky.id) ?? 0, participant, admin)),
    myVotes: {
      skills: mine?.dots.filter((dot) => dot.group === "skill").map((dot) => dot.stickyId) ?? [],
      channel: mine?.dots.find((dot) => dot.group === "hunt")?.stickyId ?? null,
      dotIds: mine?.dots.map((dot) => ({ id: dot.id, stickyId: dot.stickyId, group: dot.group })) ?? [],
    },
  });
  const etag = etagOf(payload);
  const headers = new Headers({
    etag,
    "x-council-digest": etag,
    "cache-control": "private, no-cache",
  });
  if (stateUnchanged(request, url, etag)) return new Response(null, { status: 304, headers });
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(payload, { status: 200, headers });
}

/**
 * Netlify rewrites a compressed response's ETag to a weak tag (W/"..."), so an
 * exact compare never 304s. Weak comparison ignores the W/ prefix. A comma-separated
 * If-None-Match matches when any opaque tag matches, and * matches the current board.
 * X-Council-Digest is the same tag on a header Netlify does not rewrite; the client
 * may send it back on that header or as ?digest=.
 */
function stateUnchanged(request: Request, url: URL, etag: string): boolean {
  if (etagMatches(request.headers.get("if-none-match"), etag)) return true;
  const digest = request.headers.get("x-council-digest") ?? url.searchParams.get("digest");
  return digestMatches(digest, etag);
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (!header) return false;
  if (header === "*") return true;
  const ours = opaqueTag(etag);
  if (!ours) return false;
  return splitValidators(header).some((part) => opaqueTag(part) === ours);
}

function digestMatches(provided: string | null, etag: string): boolean {
  if (!provided) return false;
  const ours = opaqueTag(etag);
  const theirs = opaqueTag(provided);
  return ours.length > 0 && theirs === ours;
}

function opaqueTag(tag: string): string {
  return tag.trim().replace(/^W\//i, "").trim();
}

function splitValidators(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of header) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === "," && !quoted) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function presentSticky(sticky: Sticky, votes: number, participant: string | null, admin: boolean) {
  const row: Record<string, unknown> = {
    id: sticky.id,
    column: sticky.column,
    text: sticky.text,
    author: sticky.showName || admin ? sticky.author : "",
    showName: sticky.showName,
    late: sticky.late,
    demo: sticky.demo === true,
    createdAt: sticky.createdAt,
    today: sticky.today,
    year: sticky.year,
    stackOf: sticky.stackOf,
    label: sticky.label,
    noAuto: sticky.noAuto,
    votes,
    mine: sticky.participantId === participant,
  };
  if (sticky.owner) row.owner = sticky.owner;
  if (sticky.cadence) row.cadence = sticky.cadence;
  if (sticky.tools) row.tools = sticky.tools;
  if (sticky.ai) row.ai = sticky.ai;
  return row;
}

function phoneCount(stickies: readonly Sticky[], votes: readonly VoteDoc[]): number {
  const ids = new Set<string>();
  for (const sticky of stickies) {
    if (!sticky.hidden && sticky.participantId) ids.add(sticky.participantId);
  }
  for (const vote of votes) {
    if (vote.dots.length > 0 && vote.participantId) ids.add(vote.participantId);
  }
  return ids.size;
}

function etagOf(payload: string): string {
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `"${(hash >>> 0).toString(16)}-${payload.length}"`;
}

async function createSticky(request: Request, deps: CouncilDeps, session: string): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  const rated = await limitWrite(deps, session, data.participantId);
  if (rated) return rated;
  const participantId = readId(data.participantId, "invalid participant");
  const column = readColumn(data.column);
  const name = plainName(data.name ?? data.author ?? "");
  if (!name.ok) return json(400, { error: speak(name.error) });
  const limit = column === "harvest" ? HARVEST_MAX : HIRING.has(column) ? HIRING_MAX : 140;
  const text = plainText(data.text, Math.min(140, limit));
  if (!text.ok) return json(400, { error: speak(text.error) });
  if (column === "harvest" && isAnonymousName(name.text)) return json(400, { error: "Add your name on this offer, then post." });
  const fields = readFields(data);
  const today = readPoint(data.today);
  const year = readPoint(data.year);
  const clientRaw = typeof data.clientId === "string" ? data.clientId : "";
  const id = clientRaw ? readId(clientRaw, "invalid id") : deps.createId?.() || crypto.randomUUID();
  const existing = await findByClient(deps.store, session, clientRaw || id);
  if (existing) return json(200, { sticky: publicBrief(existing), deduped: true });
  const meta = await loadMeta(deps.store, session, deps.now);
  const ip = deps.ip || "unknown";
  const visible = () => loadStickies(deps.store, session);
  const personKey = capKey(session, "p", await digestKey(participantId), column);
  const networkKey = capKey(session, "ip", await digestKey(ip), column);
  const personOk = await claim(deps.store, personKey, id, STICKY_CAP, async () =>
    (await visible()).filter((sticky) => sticky.participantId === participantId && sticky.column === column && !sticky.hidden).map((sticky) => sticky.id),
  );
  if (!personOk) return json(409, { error: "too many stickies" });
  const networkOk = await claimNetwork(deps.store, networkKey, id, networkStickyCap(readServerEnv("COUNCIL_NETWORK_STICKY_CAP")), async () =>
    (await visible()).filter((sticky) => sticky.ip === ip && sticky.column === column && !sticky.hidden).map((sticky) => sticky.id),
  );
  if (!networkOk) {
    await release(deps.store, personKey, id);
    return json(409, { error: "too many stickies" });
  }
  const nowIso = new Date(deps.now).toISOString();
  const siblings = HIRING.has(column) ? await visible() : [];
  const sticky: Sticky = {
    id,
    clientId: clientRaw || id,
    participantId,
    column,
    text: text.text,
    author: name.text,
    showName: column === "harvest" || (column === "channel" && data.showName === true),
    late: meta.beat > beatOfColumn(column),
    hidden: false,
    stackOf: HIRING.has(column) ? autoParentId(siblings, column, text.text) : null,
    label: "",
    noAuto: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    owner: fields.owner ?? "",
    cadence: fields.cadence ?? "",
    tools: fields.tools ?? "",
    ai: fields.ai ?? "",
    today,
    year,
    demo: false,
    ip,
  };
  const wrote = await commit(deps.store, stickyKey(session, sticky.id), JSON.stringify(sticky), null);
  if (!wrote) {
    await release(deps.store, personKey, id);
    await release(deps.store, networkKey, id);
    const raced = await loadSticky(deps.store, session, sticky.id);
    if (raced) return json(200, { sticky: publicBrief(raced), deduped: true });
    return json(503, { error: "busy" });
  }
  await deps.store.set(clientKey(session, sticky.clientId), sticky.id);
  await refreshView(deps.store, session, deps.now);
  return json(201, { sticky: publicBrief(sticky), deduped: false });
}

async function patchSticky(request: Request, deps: CouncilDeps, session: string, id: string): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  const rated = await limitWrite(deps, session, data.participantId);
  if (rated) return rated;
  const participantId = readId(data.participantId, "invalid participant");
  const sticky = await updateSticky(deps.store, session, id, (current) => {
    if (current.participantId !== participantId) return false;
    if (typeof data.text === "string") {
      const limit = current.column === "harvest" ? HARVEST_MAX : HIRING.has(current.column) ? HIRING_MAX : 140;
      const text = plainText(data.text, Math.min(140, limit));
      if (!text.ok) throw json(400, { error: speak(text.error) });
      current.text = text.text;
    }
    const fields = readFields(data, true);
    if (fields.owner !== undefined) current.owner = fields.owner;
    if (fields.cadence !== undefined) current.cadence = fields.cadence;
    if (fields.tools !== undefined) current.tools = fields.tools;
    if (fields.ai !== undefined) current.ai = fields.ai;
    if ("today" in data) current.today = readPoint(data.today);
    if ("year" in data) current.year = readPoint(data.year);
    current.updatedAt = new Date(deps.now).toISOString();
    return true;
  });
  if (!sticky) return json(404, { error: "not found" });
  await refreshView(deps.store, session, deps.now);
  return json(200, { sticky: publicBrief(sticky) });
}

async function deleteSticky(request: Request, deps: CouncilDeps, session: string, id: string): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  const rated = await limitWrite(deps, session, data.participantId);
  if (rated) return rated;
  const participantId = readId(data.participantId, "invalid participant");
  const sticky = await loadSticky(deps.store, session, id);
  if (!sticky || sticky.participantId !== participantId) return json(404, { error: "not found" });
  await deps.store.delete(stickyKey(session, id));
  await deps.store.delete(clientKey(session, sticky.clientId));
  await release(deps.store, capKey(session, "p", await digestKey(participantId), sticky.column), id);
  if (sticky.ip) await release(deps.store, capKey(session, "ip", await digestKey(sticky.ip), sticky.column), id);
  await refreshView(deps.store, session, deps.now);
  return json(200, { ok: true });
}

async function addVote(request: Request, deps: CouncilDeps, session: string): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  const rated = await limitWrite(deps, session, data.participantId);
  if (rated) return rated;
  const participantId = readId(data.participantId, "invalid participant");
  const meta = await loadMeta(deps.store, session, deps.now);
  if (meta.locked) return json(423, { error: "locked" });
  if (data.undo === true) return removeLastDot(deps, session, participantId);
  const clientId = typeof data.clientId === "string" ? data.clientId : "";
  const held = await readVote(deps.store, session, participantId);
  if (clientId && held.dots.some((dot) => dot.clientId === clientId)) return json(200, { votes: summarize(held), deduped: true });
  if (!meta.voteOpen) return json(409, { error: "voting closed" });
  const sticky = await loadSticky(deps.store, session, String(data.stickyId ?? ""));
  if (!sticky || sticky.hidden) return json(404, { error: "not found" });
  const group = sticky.column === "pm" || sticky.column === "designer" ? "skill" : sticky.column === "channel" ? "hunt" : null;
  if (!group) return json(400, { error: "not a voting column" });
  const dot: Dot = {
    id: deps.createId?.() || crypto.randomUUID(),
    clientId: clientId || crypto.randomUUID(),
    stickyId: sticky.id,
    group,
    createdAt: new Date(deps.now).toISOString(),
  };
  const saved = await revise<VoteDoc>(deps.store, voteKey(session, participantId), () => ({ participantId, dots: [] }), (doc) => {
    if (clientId && doc.dots.some((item) => item.clientId === clientId)) return doc;
    const skills = doc.dots.filter((item) => item.group === "skill");
    const hunts = doc.dots.filter((item) => item.group === "hunt");
    if (group === "skill" && skills.length >= 2) throw json(409, { error: "vote limit" });
    if (group === "hunt" && hunts.length >= 1) throw json(409, { error: "vote limit" });
    return { ...doc, dots: [...doc.dots, dot] };
  });
  if (!saved.dots.some((item) => item.id === dot.id)) return json(200, { votes: summarize(saved), deduped: true });
  await refreshView(deps.store, session, deps.now);
  return json(201, { votes: summarize(saved), deduped: false });
}

async function undoVote(request: Request, deps: CouncilDeps, session: string): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  const rated = await limitWrite(deps, session, data.participantId);
  if (rated) return rated;
  const participantId = readId(data.participantId, "invalid participant");
  return removeLastDot(deps, session, participantId, typeof data.dotId === "string" ? data.dotId : null);
}

async function removeLastDot(deps: CouncilDeps, session: string, participantId: string, dotId?: string | null): Promise<Response> {
  const doc = await revise<VoteDoc>(deps.store, voteKey(session, participantId), () => ({ participantId, dots: [] }), (current) => ({
    ...current,
    dots: dotId ? current.dots.filter((item) => item.id !== dotId) : current.dots.slice(0, -1),
  }));
  await refreshView(deps.store, session, deps.now);
  return json(200, { votes: summarize(doc) });
}

async function admin(request: Request, deps: CouncilDeps, session: string, url: URL): Promise<Response> {
  const provided = url.searchParams.get("admin") ?? url.searchParams.get("k");
  const denied = await adminDenial(deps, session, provided);
  if (denied) return denied;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  const action = String(data.action ?? "");
  if (action === "reset" || action === "seed") {
    if (typeof data.sessionId !== "string" || data.sessionId !== session) {
      return json(400, { error: "session id required" });
    }
  }
  if (action === "reset") {
    const keys = await deps.store.list(`${session}/`);
    for (const key of keys) {
      if (key.startsWith(`${session}/`)) await deps.store.delete(key);
    }
    deps.boards?.delete(session);
    return json(200, { ok: true, sessionId: session, cleared: keys.length });
  }
  if (action === "seed") return seedSession(deps, session);
  if (action === "hide" && typeof data.stickyId === "string") {
    const hidden = data.hidden !== false;
    const sticky = await updateSticky(deps.store, session, data.stickyId, (current) => {
      current.hidden = hidden;
      current.updatedAt = new Date(deps.now).toISOString();
      return true;
    });
    if (!sticky) return json(404, { error: "not found" });
    const person = capKey(session, "p", await digestKey(sticky.participantId), sticky.column);
    if (hidden) await release(deps.store, person, sticky.id);
    else await claim(deps.store, person, sticky.id, STICKY_CAP, async () => []);
    if (sticky.ip) {
      const network = capKey(session, "ip", await digestKey(sticky.ip), sticky.column);
      if (hidden) await release(deps.store, network, sticky.id);
      else await claim(deps.store, network, sticky.id, networkStickyCap(readServerEnv("COUNCIL_NETWORK_STICKY_CAP")), async () => []);
    }
    await refreshView(deps.store, session, deps.now);
    return json(200, { ok: true });
  }
  if (action === "lock" || action === "unlock") {
    const meta = await saveMeta(deps, session, (current) => {
      current.locked = action === "lock";
    });
    return json(200, { ok: true, locked: meta.locked });
  }
  if (action === "phase") return phase(deps, session, data);
  if (action === "merge") return mergeStickies(deps, session, data);
  if (action === "split") return splitSticky(deps, session, data);
  if (action === "label") return labelSticky(deps, session, data);
  return json(400, { error: "unknown action" });
}

async function phase(deps: CouncilDeps, session: string, data: Record<string, unknown>): Promise<Response> {
  const meta = await saveMeta(deps, session, (current) => {
    const beat = Number(data.beat);
    if (beat === 1 || beat === 2 || beat === 3 || beat === 4) current.beat = beat;
    if (typeof data.voteOpen === "boolean") current.voteOpen = data.voteOpen;
    if (typeof data.revealed === "boolean") current.revealed = data.revealed;
    if (typeof data.arrowsOn === "boolean") current.arrowsOn = data.arrowsOn;
  });
  return json(200, { ok: true, meta });
}

async function mergeStickies(deps: CouncilDeps, session: string, data: Record<string, unknown>): Promise<Response> {
  const parent = await loadSticky(deps.store, session, String(data.parentId ?? ""));
  const child = await loadSticky(deps.store, session, String(data.childId ?? ""));
  if (!parent || !child || parent.column !== child.column || parent.id === child.id) return json(400, { error: "merge needs two stickies" });
  const rootId = parent.stackOf || parent.id;
  if (child.id === rootId) return json(400, { error: "merge needs two stickies" });
  const saved = await updateSticky(deps.store, session, child.id, (current) => {
    current.stackOf = rootId;
    current.noAuto = false;
    current.updatedAt = new Date(deps.now).toISOString();
    return true;
  });
  if (!saved) return json(400, { error: "merge needs two stickies" });
  await refreshView(deps.store, session, deps.now);
  return json(200, { ok: true, stackOf: rootId });
}

async function splitSticky(deps: CouncilDeps, session: string, data: Record<string, unknown>): Promise<Response> {
  const sticky = await loadSticky(deps.store, session, String(data.stickyId ?? ""));
  if (!sticky) return json(404, { error: "not found" });
  const now = new Date(deps.now).toISOString();
  const touch = (current: Sticky) => {
    current.stackOf = null;
    current.noAuto = true;
    current.updatedAt = now;
    return true;
  };
  if (sticky.stackOf) {
    const saved = await updateSticky(deps.store, session, sticky.id, touch);
    if (saved) await refreshView(deps.store, session, deps.now);
    return json(200, { ok: true });
  }
  const all = await loadStickies(deps.store, session);
  const saved: Sticky[] = [];
  for (const other of all) {
    if (other.stackOf !== sticky.id && other.id !== sticky.id) continue;
    const next = await updateSticky(deps.store, session, other.id, touch);
    if (next) saved.push(next);
  }
  await refreshView(deps.store, session, deps.now);
  return json(200, { ok: true });
}

async function labelSticky(deps: CouncilDeps, session: string, data: Record<string, unknown>): Promise<Response> {
  let labelText = "";
  if (data.label !== "") {
    const label = plainText(data.label, LABEL_MAX);
    if (!label.ok) return json(400, { error: speak(label.error) });
    labelText = label.text;
  }
  const sticky = await updateSticky(deps.store, session, String(data.stickyId ?? ""), (current) => {
    current.label = labelText;
    current.updatedAt = new Date(deps.now).toISOString();
    return true;
  });
  if (!sticky) return json(404, { error: "not found" });
  await refreshView(deps.store, session, deps.now);
  return json(200, { ok: true, label: sticky.label });
}

async function seedSession(deps: CouncilDeps, session: string): Promise<Response> {
  const existing = await loadStickies(deps.store, session);
  if (existing.some((sticky) => !sticky.demo)) {
    return json(409, {
      error: "Refusing to seed while the board has posts",
      warning: "This board is only seeded when it is empty. Reset it first.",
    });
  }
  for (const sticky of existing) {
    if (!sticky.demo) continue;
    await deps.store.delete(stickyKey(session, sticky.id));
    await deps.store.delete(clientKey(session, sticky.clientId));
  }
  const voteKeys = await deps.store.list(`${session}/votes/`);
  for (const key of voteKeys) {
    if (key.includes("/votes/demovoter")) await deps.store.delete(key);
  }
  const stickies = demoStickies(deps.now);
  for (const sticky of stickies) {
    await deps.store.set(stickyKey(session, sticky.id), JSON.stringify(sticky));
    await deps.store.set(clientKey(session, sticky.clientId), sticky.id);
  }
  for (const vote of demoVotes(stickies, deps.now)) {
    await deps.store.set(voteKey(session, vote.participantId), JSON.stringify(vote));
  }
  deps.boards?.delete(session);
  await refreshView(deps.store, session, deps.now);
  return json(200, {
    ok: true,
    sessionId: session,
    warning: "",
    counts: {
      pm: stickies.filter((sticky) => sticky.column === "pm").length,
      designer: stickies.filter((sticky) => sticky.column === "designer").length,
      channel: stickies.filter((sticky) => sticky.column === "channel").length,
      testing: stickies.filter((sticky) => sticky.column === "testing").length,
      harvest: stickies.filter((sticky) => sticky.column === "harvest").length,
    },
  });
}

async function exportSession(deps: CouncilDeps, session: string, url: URL): Promise<Response> {
  const denied = await adminDenial(deps, session, url.searchParams.get("admin") ?? url.searchParams.get("k"));
  if (denied) return denied;
  const format = url.searchParams.get("format") ?? "json";
  const board = await loadBoard(deps, session);
  const record = await loadRecord(deps, session);
  const bundle = buildExport({
    sessionId: session,
    exportedAt: new Date(deps.now).toISOString(),
    meta: board.meta,
    stickies: board.stickies,
    votes: board.votes,
    content: record?.content,
  });
  if (format === "csv") {
    return new Response(bundle.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${bundle.filenameStem}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  }
  if (format === "html") {
    return new Response(bundle.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="capture-sheet-${session}.html"`,
        "cache-control": "private, no-store",
      },
    });
  }
  if (format !== "json") return json(400, { error: "invalid format" });
  return new Response(bundle.json, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${bundle.filenameStem}.json"`,
      "cache-control": "private, no-store",
    },
  });
}

function demoStickies(now: number): Sticky[] {
  const pm = [
    "Ships prototypes in Cursor, not decks",
    "Writes evals for AI features",
    "Reads the data without an analyst",
    "Kills own ideas fast",
    "Talks to a customer every week",
    "Taste: knows good when they see it",
    "Ships the first version in days",
    "Writes the spec after the prototype",
    "Can query the warehouse",
    "Says no to vanity metrics",
  ];
  const channel = [
    "Hackathon judges and finalists",
    "Indie app makers shipping on X",
    "Ex-founders after a shutdown",
    "Bootcamp demo days",
    "Open source maintainers",
    "Design engineers from side projects",
    "University builder clubs",
    "Conference workshop teachers",
    "Alumni of small studios",
    "People who reply to a prototype",
  ];
  const offers = [
    ["Demo 1", "our 30-day test plan template"],
    ["Demo 2", "an intro to the research contractor we used"],
    ["Demo 3", "20 minutes on how we run holdouts"],
    ["Demo 4", "our take-home that is not free work"],
    ["Demo 5", "a Slack group of indie app makers"],
    ["Demo 6", "the interview rubric for builder PMs"],
    ["Demo 7", "a weekly testing standup template"],
    ["Demo 8", "notes on what AI got wrong in research"],
  ];
  const rows: Sticky[] = [];
  const push = (column: Column, text: string, index: number, author = "", extra?: Partial<Sticky>) => {
    const createdAt = new Date(now + rows.length * 1000).toISOString();
    rows.push({
      id: `demo${column}${String(index).padStart(2, "0")}xxxxxxxx`,
      clientId: `democlient${column}${index}`,
      participantId: "demodemo01",
      column,
      text,
      author,
      showName: column === "harvest",
      late: false,
      hidden: false,
      stackOf: null,
      label: "",
      noAuto: false,
      createdAt,
      updatedAt: createdAt,
      owner: "",
      cadence: "",
      tools: "",
      ai: "",
      today: null,
      year: null,
      demo: true,
      ...extra,
    });
  };
  pm.forEach((text, index) => push("pm", text, index + 1));
  channel.forEach((text, index) => push("channel", text, index + 1));
  for (let index = 0; index < 10; index += 1) {
    const today = { x: round((index % 5) / 4), y: round((index % 3) / 2) };
    const year = { x: round(Math.min(1, today.x + 0.25)), y: round(Math.min(1, today.y + 0.35)) };
    push("testing", `Squad ${index + 1}: weekly checks`, index + 1, "", {
      owner: index % 2 === 0 ? "one lead" : "every PM",
      cadence: index % 2 === 0 ? "monthly" : "weekly",
      tools: index % 2 === 0 ? "a doc and five calls" : "Statsig",
      ai: index % 3 === 0 ? "summarizes interviews" : "drafts hypotheses",
      today,
      year,
    });
  }
  offers.forEach(([author, text], index) => push("harvest", text, index + 1, author));
  return rows;
}

function demoVotes(stickies: readonly Sticky[], now: number): VoteDoc[] {
  const pm = stickies.filter((sticky) => sticky.column === "pm");
  const channel = stickies.filter((sticky) => sticky.column === "channel");
  return [0, 1, 2, 3, 4, 5].map((index) => ({
    participantId: `demovoter${index}`,
    dots: [
      dot(`dskill${index}a`, pm[index % pm.length].id, "skill", now),
      dot(`dskill${index}b`, pm[(index + 5) % pm.length].id, "skill", now + 1),
      dot(`dhunt${index}`, channel[index % channel.length].id, "hunt", now + 2),
    ],
  }));
}

function dot(id: string, stickyId: string, group: "skill" | "hunt", now: number): Dot {
  return { id, clientId: id, stickyId, group, createdAt: new Date(now).toISOString() };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const NETWORK_RATE_SHARDS = 8;
/** Leave this many network sticky slots uncounted so a room does not serialize on one cap blob. */
const NETWORK_CAP_HEADROOM = 40;

function rateShard(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % NETWORK_RATE_SHARDS;
}

async function limitWrite(deps: CouncilDeps, session: string, participantRaw: unknown): Promise<Response | null> {
  const participant = typeof participantRaw === "string" && participantRaw ? participantRaw : "anon";
  const ipBase = `${session}/rate/ip/${await digestKey(deps.ip || "unknown")}`;
  const shard = rateShard(participant);
  const ipKey = `${ipBase}/${shard}`;
  const whoKey = `${session}/rate/who/${await digestKey(participant)}`;
  const ipLimit = networkRateLimit(readServerEnv("COUNCIL_NETWORK_RATE_LIMIT"));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [shards, who] = await Promise.all([
      Promise.all(Array.from({ length: NETWORK_RATE_SHARDS }, (_, index) => readEtag(deps.store, `${ipBase}/${index}`))),
      readEtag(deps.store, whoKey),
    ]);
    const ipDocs = shards.map((item) => freshWindow(parseJson<RateDoc>(item.value), deps.now));
    const ipTotal = ipDocs.reduce((sum, doc) => sum + doc.count, 0);
    const whoDoc = freshWindow(parseJson<RateDoc>(who.value), deps.now);
    if (ipTotal >= ipLimit || whoDoc.count >= RATE_LIMIT) {
      const blocking = ipTotal >= ipLimit ? ipDocs[shard] : whoDoc;
      const retryAfter = Math.max(1, Math.ceil((blocking.windowStartedAt + RATE_WINDOW_MS - deps.now) / 1000));
      return json(429, { error: "rate limited" }, { "retry-after": String(retryAfter) });
    }
    const ip = shards[shard];
    const ipDoc = ipDocs[shard];
    const nextIp = { windowStartedAt: ipDoc.windowStartedAt, count: ipDoc.count + 1 };
    const ipOk = await commit(deps.store, ipKey, JSON.stringify(nextIp), ip.value === null ? null : ip.etag);
    if (!ipOk) {
      await sleep(Math.min(8, 1 + attempt));
      continue;
    }
    const nextWho = { windowStartedAt: whoDoc.windowStartedAt, count: whoDoc.count + 1 };
    const whoOk = await commit(deps.store, whoKey, JSON.stringify(nextWho), who.value === null ? null : who.etag);
    if (whoOk) return null;
    await revise<RateDoc>(deps.store, ipKey, () => nextIp, (doc) => ({ ...doc, count: Math.max(0, doc.count - 1) }));
    await sleep(Math.min(8, 1 + attempt));
  }
  return json(429, { error: "rate limited" }, { "retry-after": "1" });
}

function freshWindow(current: RateDoc | null | undefined, now: number): RateDoc {
  if (!current || now - current.windowStartedAt >= RATE_WINDOW_MS) return { windowStartedAt: now, count: 0 };
  return current;
}

async function digestKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBody(request: Request, max = BODY_MAX): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return { ok: false, response: json(413, { error: "body too large" }) };
  const text = await request.text();
  if (text.length > max) return { ok: false, response: json(413, { error: "body too large" }) };
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json(400, { error: "invalid json" }) };
  }
}

function readId(value: unknown, error: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw json(400, { error: error || "invalid id" });
  }
  return value;
}

function readColumn(value: unknown): Column {
  if (typeof value !== "string" || !COLUMNS.includes(value as Column)) throw json(400, { error: "invalid column" });
  return value as Column;
}

function readPoint(value: unknown): Point | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw json(400, { error: "invalid point" });
  const point = value as { x?: unknown; y?: unknown };
  if (typeof point.x !== "number" || typeof point.y !== "number") throw json(400, { error: "invalid point" });
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw json(400, { error: "invalid point" });
  }
  return { x: point.x, y: point.y };
}

function readFields(data: Record<string, unknown>, partial = false): {
  owner?: string;
  cadence?: string;
  tools?: string;
  ai?: string;
} {
  const read = (key: string): string | undefined => {
    if (!(key in data)) return partial ? undefined : "";
    if (data[key] === undefined || data[key] === "") return "";
    const parsed = plainText(data[key], FIELD_MAX);
    if (!parsed.ok) throw json(400, { error: speak(parsed.error) });
    return parsed.text;
  };
  return { owner: read("owner"), cadence: read("cadence"), tools: read("tools"), ai: read("ai") };
}

function publicBrief(sticky: Sticky) {
  return {
    id: sticky.id,
    column: sticky.column,
    text: sticky.text,
    late: sticky.late,
    demo: sticky.demo === true,
    showName: sticky.showName,
    author: sticky.showName ? sticky.author : "",
    today: sticky.today,
    year: sticky.year,
  };
}

function summarize(doc: VoteDoc) {
  return {
    skills: doc.dots.filter((dot) => dot.group === "skill").map((dot) => dot.stickyId),
    channel: doc.dots.find((dot) => dot.group === "hunt")?.stickyId ?? null,
  };
}

function countVotes(votes: readonly VoteDoc[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const vote of votes) {
    for (const dot of vote.dots) map.set(dot.stickyId, (map.get(dot.stickyId) ?? 0) + 1);
  }
  return map;
}

function emptyBoard(now: number): BoardFile {
  return {
    meta: {
      beat: 1,
      voteOpen: false,
      revealed: false,
      arrowsOn: true,
      locked: false,
      postingOpen: true,
      updatedAt: new Date(now).toISOString(),
    },
    stickies: [],
    votes: [],
    clients: {},
    rates: {},
  };
}

interface ViewFile {
  digest: string;
  board: BoardFile;
}

interface Listing {
  digest: string;
  stickyEtags: Map<string, string>;
  voteEtags: Map<string, string>;
  metaEtag: string;
}

function viewKey(session: string): string {
  return `${session}/view`;
}

function metaKey(session: string): string {
  return `${session}/meta`;
}

function stickyKey(session: string, id: string): string {
  return `${session}/sticky/${id}`;
}

function voteKey(session: string, participantId: string): string {
  return `${session}/votes/${participantId}`;
}

function clientKey(session: string, clientId: string): string {
  return `${session}/client/${clientId}`;
}

function capKey(session: string, kind: "p" | "ip", hash: string, column: string): string {
  return `${session}/cap/${kind}/${hash}/${column}`;
}

/** Reads never create a blob. A view cache is used only when its digest still matches the item keys. */
async function loadBoard(deps: CouncilDeps, session: string): Promise<BoardFile> {
  const cached = deps.boards?.get(session);
  if (cached) return cached;
  const board = await readBoard(deps.store, session, deps.now);
  deps.boards?.set(session, board);
  return board;
}

async function readBoard(store: CouncilStore, session: string, now: number): Promise<BoardFile> {
  if (store.listEtags && store.getEtag) {
    const view = parseView(await store.get(viewKey(session)));
    if (view && view.digest === (await snapshotListing(store, session)).digest) return view.board;
  }
  return assemble(store, session, now);
}

async function assemble(store: CouncilStore, session: string, now: number): Promise<BoardFile> {
  const [meta, stickies, votes] = await Promise.all([loadMeta(store, session, now), loadStickies(store, session), loadVotes(store, session)]);
  return { meta, stickies, votes, clients: {}, rates: {} };
}

async function loadMeta(store: CouncilStore, session: string, now: number): Promise<Meta> {
  const meta = parseJson<Meta>(await store.get(metaKey(session)));
  return meta ? { ...emptyBoard(now).meta, ...meta } : emptyBoard(now).meta;
}

async function loadStickies(store: CouncilStore, session: string): Promise<Sticky[]> {
  const keys = await store.list(`${session}/sticky/`);
  const values = await Promise.all(keys.map((key) => store.get(key)));
  const stickies: Sticky[] = [];
  for (const raw of values) {
    const sticky = parseJson<Sticky>(raw);
    if (sticky?.id && sticky.column) stickies.push(sticky);
  }
  return stickies;
}

async function loadSticky(store: CouncilStore, session: string, id: string): Promise<Sticky | null> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  return parseJson<Sticky>(await store.get(stickyKey(session, id)));
}

async function loadVotes(store: CouncilStore, session: string): Promise<VoteDoc[]> {
  const keys = await store.list(`${session}/votes/`);
  const values = await Promise.all(keys.map((key) => store.get(key)));
  const votes: VoteDoc[] = [];
  for (const raw of values) {
    const vote = parseJson<VoteDoc>(raw);
    if (vote?.participantId && Array.isArray(vote.dots)) votes.push(vote);
  }
  return votes;
}

async function readVote(store: CouncilStore, session: string, participantId: string): Promise<VoteDoc> {
  return parseJson<VoteDoc>(await store.get(voteKey(session, participantId))) ?? { participantId, dots: [] };
}

async function findByClient(store: CouncilStore, session: string, clientId: string): Promise<Sticky | null> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(clientId)) return null;
  const id = await store.get(clientKey(session, clientId));
  if (!id) return null;
  return loadSticky(store, session, id);
}

async function saveMeta(deps: CouncilDeps, session: string, update: (meta: Meta) => void): Promise<Meta> {
  const meta = await revise<Meta>(deps.store, metaKey(session), () => emptyBoard(deps.now).meta, (current) => {
    const next = { ...current };
    update(next);
    next.updatedAt = new Date(deps.now).toISOString();
    return next;
  });
  await refreshView(deps.store, session, deps.now);
  return meta;
}

async function updateSticky(store: CouncilStore, session: string, id: string, update: (sticky: Sticky) => boolean): Promise<Sticky | null> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  const key = stickyKey(session, id);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await readEtag(store, key);
    const sticky = parseJson<Sticky>(current.value);
    if (!sticky) return null;
    if (!update(sticky)) return null;
    const ok = await commit(store, key, JSON.stringify(sticky), current.etag);
    if (ok) return sticky;
    await sleep(4 + attempt * 4);
  }
  throw json(503, { error: "busy" });
}

/** Exact per-person caps stay on claim(). The shared-IP cap skips its blob until the room is near the limit. */
async function claimNetwork(store: CouncilStore, key: string, id: string, cap: number, existing: () => Promise<string[]>): Promise<boolean> {
  const current = await readEtag(store, key);
  const stored = current.value ? (parseJson<{ ids?: string[] }>(current.value)?.ids ?? []) : null;
  if (stored?.includes(id)) return true;
  const headroom = Math.min(NETWORK_CAP_HEADROOM, Math.floor(cap / 2));
  const counted = stored ? stored.length : (await existing()).length;
  if (counted + 1 <= cap - headroom) return true;
  return claim(store, key, id, cap, existing);
}

async function claim(store: CouncilStore, key: string, id: string, cap: number, existing: () => Promise<string[]>): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await readEtag(store, key);
    const ids = current.value ? (parseJson<{ ids?: string[] }>(current.value)?.ids ?? []) : [...new Set(await existing())];
    if (ids.includes(id)) return true;
    if (ids.length >= cap) return false;
    const ok = await commit(store, key, JSON.stringify({ ids: [...ids, id] }), current.value === null ? null : current.etag);
    if (ok) return true;
    await sleep(Math.min(8, 1 + attempt));
  }
  return false;
}

async function release(store: CouncilStore, key: string, id: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await readEtag(store, key);
    if (!current.value) return;
    const ids = (parseJson<{ ids?: string[] }>(current.value)?.ids ?? []).filter((item) => item !== id);
    const ok = await commit(store, key, JSON.stringify({ ids }), current.etag);
    if (ok) return;
    await sleep(4 + attempt * 4);
  }
}

async function revise<T>(store: CouncilStore, key: string, create: () => T, update: (current: T) => T): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await readEtag(store, key);
    const doc = current.value ? (parseJson<T>(current.value) ?? create()) : create();
    const next = update(doc);
    if (current.value !== null && JSON.stringify(next) === current.value) return doc;
    const ok = await commit(store, key, JSON.stringify(next), current.value === null ? null : current.etag);
    if (ok) return next;
    await sleep(4 + attempt * 4);
  }
  throw json(503, { error: "busy" });
}

async function refreshView(store: CouncilStore, session: string, now: number): Promise<void> {
  if (!store.compareAndSet || !store.getEtag || !store.listEtags) return;
  const key = viewKey(session);
  const before = await snapshotListing(store, session);
  const board = await readListed(store, session, now, before);
  const after = await snapshotListing(store, session);
  if (!board || before.digest !== after.digest) {
    await store.delete(key);
    return;
  }
  const current = await store.getEtag(key);
  const payload = JSON.stringify({ digest: after.digest, board });
  if (current.value === payload) return;
  const ok = await store.compareAndSet(key, payload, current.etag);
  if (!ok) {
    await store.delete(key);
    return;
  }
  const check = await snapshotListing(store, session);
  if (check.digest !== after.digest) await store.delete(key);
}

async function snapshotListing(store: CouncilStore, session: string): Promise<Listing> {
  const list = store.listEtags;
  const meta = store.getEtag;
  if (!list || !meta) return { digest: "", stickyEtags: new Map(), voteEtags: new Map(), metaEtag: "" };
  const [stickies, votes, metaDoc] = await Promise.all([list(`${session}/sticky/`), list(`${session}/votes/`), meta(metaKey(session))]);
  const stickyEtags = new Map(stickies.map((entry) => [entry.key.slice(`${session}/sticky/`.length), entry.etag]));
  const voteEtags = new Map(votes.map((entry) => [entry.key.slice(`${session}/votes/`.length), entry.etag]));
  const metaEtag = metaDoc.etag ?? "";
  const lines = [
    ...stickies.map((entry) => `${entry.key}\t${entry.etag}`),
    ...votes.map((entry) => `${entry.key}\t${entry.etag}`),
    `meta\t${metaEtag}`,
  ];
  return { digest: etagOf(lines.sort().join("\n")), stickyEtags, voteEtags, metaEtag };
}

/** Board bytes that were read at the listing's etags. A newer vote makes this return null instead of publishing the stale copy. */
async function readListed(store: CouncilStore, session: string, now: number, listed: Listing): Promise<BoardFile | null> {
  const metaDoc = await readEtag(store, metaKey(session));
  if ((metaDoc.etag ?? "") !== listed.metaEtag) return null;
  const stickies = await Promise.all(
    [...listed.stickyEtags].map(async ([id, etag]) => {
      const doc = await readEtag(store, stickyKey(session, id));
      if ((doc.etag ?? "") !== etag || !doc.value) return null;
      return parseJson<Sticky>(doc.value);
    }),
  );
  if (stickies.some((sticky) => !sticky?.id)) return null;
  const votes = await Promise.all(
    [...listed.voteEtags].map(async ([id, etag]) => {
      const doc = await readEtag(store, voteKey(session, id));
      if ((doc.etag ?? "") !== etag || !doc.value) return null;
      return parseJson<VoteDoc>(doc.value);
    }),
  );
  if (votes.some((vote) => !vote?.participantId)) return null;
  const meta = parseJson<Meta>(metaDoc.value);
  return {
    meta: meta ? { ...emptyBoard(now).meta, ...meta } : emptyBoard(now).meta,
    stickies: stickies.filter((sticky): sticky is Sticky => Boolean(sticky)),
    votes: votes.filter((vote): vote is VoteDoc => Boolean(vote)),
    clients: {},
    rates: {},
  };
}

function parseView(raw: string | null): ViewFile | null {
  const parsed = parseJson<ViewFile>(raw);
  if (!parsed || typeof parsed.digest !== "string" || !parsed.board?.meta || !Array.isArray(parsed.board.stickies) || !Array.isArray(parsed.board.votes)) return null;
  parsed.board.clients = parsed.board.clients ?? {};
  parsed.board.rates = parsed.board.rates ?? {};
  return parsed;
}

async function readEtag(store: CouncilStore, key: string): Promise<{ value: string | null; etag: string | null }> {
  if (store.getEtag) return store.getEtag(key);
  const value = await store.get(key);
  return { value, etag: value === null ? null : "present" };
}

async function commit(store: CouncilStore, key: string, value: string, etag: string | null): Promise<boolean> {
  if (store.compareAndSet) return store.compareAndSet(key, value, etag);
  if (etag === null) {
    const existing = await store.get(key);
    if (existing !== null) return false;
  }
  await store.set(key, value);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function speak(error: string): string {
  if (error === "text is empty" || error === "text is required") return "Write a few words before posting.";
  return error;
}

async function loadRecord(deps: CouncilDeps, session: string): Promise<SessionRecord | null> {
  const cache = deps.records ?? (deps.records = new Map());
  if (cache.has(session)) return cache.get(session) ?? null;
  const record = await readSessionRecord(deps.store, session);
  cache.set(session, record);
  return record;
}

/** A registry record trusts only its own hashed key. A fixture session uses the plaintext test key. */
async function isAdmin(deps: CouncilDeps, session: string, provided: string | null): Promise<boolean> {
  const record = await loadRecord(deps, session);
  if (record) return secretMatches(provided ?? "", record.adminKeyHash);
  if (deps.sessions?.includes(session)) return adminAllowed(provided, deps.adminKey ?? "");
  return false;
}

async function adminDenial(deps: CouncilDeps, session: string, provided: string | null): Promise<Response | null> {
  if (await isAdmin(deps, session, provided)) return null;
  const record = await loadRecord(deps, session);
  const disabled = !record && !(deps.adminKey ?? "");
  return json(403, { error: disabled ? "admin disabled" : "forbidden" });
}

function creatorCredential(request: Request): string {
  const header = request.headers.get("x-council-creator");
  if (header) return header.trim();
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return match?.[1] ?? "";
}

async function catalog(request: Request, deps: CouncilDeps, method: string): Promise<Response> {
  if (!deps.creatorKey) return json(403, { error: "creator disabled" });
  if (!timingSafeEqualText(creatorCredential(request), deps.creatorKey)) return json(403, { error: "forbidden" });
  if (method === "GET") return json(200, { sessions: await listSessionRecords(deps.store) });
  if (method !== "POST") return json(405, { error: "method not allowed" });
  const body = await readBody(request, CREATOR_BODY_MAX);
  if (!body.ok) return body.response;
  const data = asRecord(body.value);
  delete data.adminKey;
  delete data.creatorKey;
  delete data.adminKeyHash;
  const created = await createSessionRecord(deps.store, data, deps.now);
  if ("error" in created) return json(created.status, { error: created.error });
  const origin = publicOrigin(request);
  const { record, adminKey } = created;
  return json(201, {
    slug: record.slug,
    title: record.title,
    adminKey,
    presenterUrl: `${origin}/council?session=${encodeURIComponent(record.slug)}`,
    joinUrl: joinTarget(origin, record.slug),
    adminUrl: `${origin}/council?session=${encodeURIComponent(record.slug)}&admin=${encodeURIComponent(adminKey)}`,
    content: {
      title: record.content.title,
      shortName: record.content.shortName,
      columns: record.content.columns,
      beats: record.content.beats.map(({ n, kicker, title, prompt }) => ({ n, kicker, title, prompt })),
      capture: { moves: record.content.capture.moves },
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" });
  if (extra) for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}
