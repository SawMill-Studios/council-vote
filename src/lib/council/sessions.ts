import { timingSafeEqualText } from "../env.ts";
import type { CouncilStore } from "./store.ts";
import { boardCopy, type BeatCopy, type BoardCopy } from "./template.ts";
import { parseSessionId, plainText } from "./text.ts";

export interface SessionRecord {
  slug: string;
  title: string;
  /** SHA-256 hex of the per-session admin key. The key itself is never stored. */
  adminKeyHash: string;
  createdAt: string;
  content: BoardCopy;
}

export function registryKey(slug: string): string {
  return `registry/${slug}`;
}

export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash the provided key and compare. A stored hash is not accepted as the key. */
export async function secretMatches(provided: string, expectedHash: string): Promise<boolean> {
  if (!provided || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  return timingSafeEqualText(await hashSecret(provided), expectedHash);
}

export function newAdminKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readSessionRecord(store: CouncilStore, slug: string): Promise<SessionRecord | null> {
  if (!parseSessionId(slug)) return null;
  return parseRecord(await store.get(registryKey(slug)));
}

export async function listSessionRecords(store: CouncilStore): Promise<Array<{ slug: string; title: string; createdAt: string }>> {
  const keys = await store.list("registry/");
  const rows: Array<{ slug: string; title: string; createdAt: string }> = [];
  for (const key of keys) {
    if (!key.startsWith("registry/")) continue;
    const record = parseRecord(await store.get(key));
    if (!record || registryKey(record.slug) !== key) continue;
    rows.push({ slug: record.slug, title: record.title, createdAt: record.createdAt });
  }
  rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return rows;
}

export async function createSessionRecord(
  store: CouncilStore,
  data: Record<string, unknown>,
  now: number,
): Promise<{ record: SessionRecord; adminKey: string } | { error: string; status: number }> {
  const slug = parseSessionId(typeof data.slug === "string" ? data.slug : null);
  if (!slug) return { error: "invalid session", status: 400 };
  const title = plainText(data.title, 80);
  if (!title.ok) {
    return { error: title.error === "text is empty" || title.error === "text is required" ? "Add a title." : title.error, status: 400 };
  }
  if (data.template !== undefined && typeof data.template !== "string") return { error: "unknown template", status: 400 };
  const base = boardCopy(typeof data.template === "string" ? data.template : undefined, title.text);
  if ("error" in base) return base;
  const content = applyOverrides(base, data);
  if ("error" in content) return content;
  const adminKey = newAdminKey();
  const record: SessionRecord = {
    slug,
    title: content.title,
    adminKeyHash: await hashSecret(adminKey),
    createdAt: new Date(now).toISOString(),
    content,
  };
  const key = registryKey(slug);
  const payload = JSON.stringify(record);
  if (payload.includes(adminKey)) return { error: "refusing to store an admin key", status: 500 };
  if (store.getEtag && store.compareAndSet) {
    const current = await store.getEtag(key);
    if (current.value !== null) return { error: "session already exists", status: 409 };
    const ok = await store.compareAndSet(key, payload, null);
    if (!ok) return { error: "session already exists", status: 409 };
  } else {
    if ((await store.get(key)) !== null) return { error: "session already exists", status: 409 };
    await store.set(key, payload);
  }
  return { record, adminKey };
}

function applyOverrides(content: BoardCopy, data: Record<string, unknown>): BoardCopy | { error: string; status: number } {
  const columns = data.columns;
  if (columns && typeof columns === "object" && !Array.isArray(columns)) {
    for (const key of ["pm", "channel", "testing", "harvest"] as const) {
      const value = (columns as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const parsed = plainText(value, 40);
      if (!parsed.ok) return { error: parsed.error, status: 400 };
      content.columns[key] = parsed.text;
    }
  }
  if (Array.isArray(data.beats)) {
    for (const item of data.beats) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "invalid beat", status: 400 };
      const beat = item as Record<string, unknown>;
      const slot = content.beats.find((entry) => entry.n === Number(beat.n));
      if (!slot) return { error: "invalid beat", status: 400 };
      const next = patchBeat(slot, beat);
      if ("error" in next) return next;
    }
  }
  const captureMoves = optionalText(data.captureMoves, 80);
  if (typeof captureMoves !== "string") return captureMoves;
  if (captureMoves) content.capture.moves = captureMoves;
  const captureHeading = optionalText(data.captureHeading, 140);
  if (typeof captureHeading !== "string") return captureHeading;
  if (captureHeading) content.capture.heading = captureHeading;
  const shortName = optionalText(data.shortName, 24);
  if (typeof shortName !== "string") return shortName;
  if (shortName) content.shortName = shortName;
  const waiting = optionalText(data.waiting, 180);
  if (typeof waiting !== "string") return waiting;
  if (waiting) content.waiting = waiting;
  return content;
}

function patchBeat(slot: BeatCopy, beat: Record<string, unknown>): { error: string; status: number } | { ok: true } {
  const fields: Array<[keyof BeatCopy, number]> = [
    ["kicker", 80],
    ["title", 80],
    ["prompt", 180],
    ["notes", 800],
  ];
  for (const [field, max] of fields) {
    if (typeof beat[field] !== "string") continue;
    const parsed = plainText(beat[field], max);
    if (!parsed.ok) return { error: parsed.error, status: 400 };
    slot[field] = parsed.text as never;
  }
  return { ok: true };
}

function optionalText(value: unknown, max: number): string | { error: string; status: number } {
  if (value === undefined || value === null || value === "") return "";
  const parsed = plainText(value, max);
  if (!parsed.ok) return { error: parsed.error, status: 400 };
  return parsed.text;
}

function parseRecord(raw: string | null): SessionRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionRecord>;
    if (!value || typeof value.slug !== "string" || !parseSessionId(value.slug)) return null;
    if (typeof value.title !== "string" || typeof value.createdAt !== "string") return null;
    if (typeof value.adminKeyHash !== "string" || !/^[0-9a-f]{64}$/.test(value.adminKeyHash)) return null;
    if (!value.content || value.content.columns?.pm === undefined || !Array.isArray(value.content.beats) || value.content.beats.length !== 4) return null;
    return value as SessionRecord;
  } catch {
    return null;
  }
}
