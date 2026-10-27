import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { clusterGroups, fitStickyLayout, remainingStickies, stickyPages } from "./council/group.ts";
import { councilClientIp, handleCouncil, type CouncilDeps } from "./council/http.ts";
import { dueItems, enqueueItem, markRetry, retryDelayMs, writeOutcome, type QueueItem } from "./council/queue.ts";
import { blobFailureClass, councilStore, isTransientBlobError, memoryCouncilStore, retryTransient, tokenExpired, type CouncilStore } from "./council/store.ts";
import { joinTarget, networkRateLimit, networkStickyCap, nextBeatMeta, pollDelayMs, presenterAdminHandoff, readSessionParam, reconnectDelayMs, resolveBeat, shortJoinLabel, type BeatMeta } from "./council/text.ts";

const KEY = "test-admin-key";
const PID = "person1234";

function deps(store: CouncilStore, extra: Partial<CouncilDeps> = {}): CouncilDeps {
  return { store, adminKey: KEY, now: 1_700_000_000_000, ip: "203.0.113.10", sessions: ["test", "philly-2026-10-27"], ...extra };
}

async function call(store: CouncilStore, path: string, init?: RequestInit, extra: Partial<CouncilDeps> = {}) {
  const response = await handleCouncil(new Request(`https://marty.brelesky.com${path}`, init), deps(store, extra));
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
}

function postSticky(store: CouncilStore, body: Record<string, unknown>, session = "test", extra: Partial<CouncilDeps> = {}) {
  return call(store, `/api/council/stickies?session=${session}`, { method: "POST", body: JSON.stringify(body) }, extra);
}

function countingStore(base: CouncilStore) {
  const counts = { sets: 0, deletes: 0 };
  const store: CouncilStore = {
    get: (key) => base.get(key),
    async set(key, value) {
      counts.sets += 1;
      await base.set(key, value);
    },
    async delete(key) {
      counts.deletes += 1;
      await base.delete(key);
    },
    list: (prefix) => base.list(prefix),
    getEtag: (key) => base.getEtag?.(key) ?? Promise.resolve({ value: null, etag: null }),
    compareAndSet: (key, value, etag) => base.compareAndSet?.(key, value, etag) ?? Promise.resolve(false),
    listEtags: (prefix) => base.listEtags?.(prefix) ?? Promise.resolve([]),
  };
  return { counts, store };
}

function latentStore(base: CouncilStore): CouncilStore {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 30));
  return {
    async get(key) {
      await wait();
      return base.get(key);
    },
    async set(key, value) {
      await wait();
      return base.set(key, value);
    },
    async delete(key) {
      await wait();
      return base.delete(key);
    },
    async list(prefix) {
      await wait();
      return base.list(prefix);
    },
    async getEtag(key) {
      await wait();
      return base.getEtag?.(key) ?? { value: null, etag: null };
    },
    async compareAndSet(key, value, etag) {
      await wait();
      return base.compareAndSet?.(key, value, etag) ?? false;
    },
    async listEtags(prefix) {
      await wait();
      return base.listEtags?.(prefix) ?? [];
    },
  };
}

test("session ids stay lowercase and isolated, with ?s= as an alias", async () => {
  assert.equal(readSessionParam(new URL("https://marty.brelesky.com/council")), null);
  assert.equal(readSessionParam(new URL("https://marty.brelesky.com/council?session=test")), "test");
  assert.equal(readSessionParam(new URL("https://marty.brelesky.com/council?s=test")), "test");
  assert.equal(readSessionParam(new URL("https://marty.brelesky.com/council?session=NOPE")), null);
  assert.equal(readSessionParam(new URL("https://marty.brelesky.com/council?session=../x")), null);
  assert.equal(shortJoinLabel("https://marty.brelesky.com"), "marty.brelesky.com/council/join");
  assert.equal(joinTarget("https://marty.brelesky.com", "test"), "https://marty.brelesky.com/council/join?session=test");
  assert.equal(joinTarget("https://marty.brelesky.com", "philly-2026-10-27"), "https://marty.brelesky.com/council/join?session=philly-2026-10-27");

  const store = memoryCouncilStore();
  const live = await postSticky(store, { participantId: PID, column: "pm", text: "Live only", clientId: "clientlive01" }, "philly-2026-10-27");
  assert.equal(live.status, 201);
  const dry = await postSticky(store, { participantId: PID, column: "pm", text: "Dry run", clientId: "clienttest01" }, "test");
  assert.equal(dry.status, 201);
  const liveState = await call(store, "/api/council/state?s=philly-2026-10-27");
  const testState = await call(store, "/api/council/state?session=test");
  assert.deepEqual(liveState.body.stickies.map((sticky: { text: string }) => sticky.text), ["Live only"]);
  assert.deepEqual(testState.body.stickies.map((sticky: { text: string }) => sticky.text), ["Dry run"]);
  assert.equal((await call(store, "/api/council/state?session=Bad")).status, 400);
});

test("text is capped, html is stripped, and oversized bodies are rejected", async () => {
  const store = memoryCouncilStore();
  const ok = await postSticky(store, { participantId: PID, column: "pm", text: "x".repeat(60), clientId: "clientsize01" });
  assert.equal(ok.status, 201);
  const tooLong = await postSticky(store, { participantId: PID, column: "pm", text: "x".repeat(61), clientId: "clientsize02" });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, "text is too long");
  const harvest = await postSticky(store, {
    participantId: PID,
    column: "harvest",
    text: "y".repeat(81),
    name: "Demo 9",
    clientId: "clientsize03",
  });
  assert.equal(harvest.status, 400);
  const tagged = await postSticky(store, {
    participantId: PID,
    column: "pm",
    text: "<b>Ships</b> <script>alert(1)</script>",
    clientId: "clienthtml01",
  });
  assert.equal(tagged.status, 201);
  assert.equal(tagged.body.sticky.text.includes("<"), false);
  assert.match(tagged.body.sticky.text, /Ships/);
  const entities = await postSticky(store, { participantId: PID, column: "pm", text: "&lt;b&gt;Ships&lt;/b&gt;", clientId: "clienthtml02" });
  assert.equal(entities.status, 201);
  assert.equal(entities.body.sticky.text, "Ships");
  const spaced = await postSticky(store, { participantId: PID, column: "pm", text: "hello  world", clientId: "clientspace1" });
  assert.equal(spaced.body.sticky.text, "hello  world");
  const blank = await postSticky(store, { participantId: PID, column: "pm", text: "\u200b\u200b", clientId: "clientblank1" });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, "Write a few words before posting.");
  const zw = await postSticky(store, { participantId: PID, column: "pm", text: "  hel\u200blo  ", clientId: "clientzw0001" });
  assert.equal(zw.body.sticky.text, "hello");
  const huge = await call(store, "/api/council/stickies?session=test", {
    method: "POST",
    headers: { "content-length": "9000" },
    body: JSON.stringify({ participantId: PID, column: "pm", text: "nope" }),
  });
  assert.equal(huge.status, 413);
});

test("a participant gets two skill dots and one hunt dot, and a repeat client id does not duplicate", async () => {
  const store = memoryCouncilStore();
  const opened = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", voteOpen: true }),
  });
  assert.equal(opened.status, 200);
  const pm = await postSticky(store, { participantId: PID, column: "pm", text: "Evals", clientId: "clientpm0001" });
  const same = await postSticky(store, { participantId: PID, column: "pm", text: "Evals", clientId: "clientpm0001" });
  assert.equal(same.status, 200);
  assert.equal(same.body.deduped, true);
  const design = await postSticky(store, { participantId: PID, column: "designer", text: "Ships UI", clientId: "clientpm0002" });
  const hunt = await postSticky(store, { participantId: PID, column: "channel", text: "Hackathons", clientId: "clientpm0003" });
  const vote = (stickyId: string, clientId: string) =>
    call(store, "/api/council/votes?session=test", {
      method: "POST",
      body: JSON.stringify({ participantId: PID, stickyId, clientId }),
    });
  assert.equal((await vote(pm.body.sticky.id, "votedot0001")).status, 201);
  assert.equal((await vote(pm.body.sticky.id, "votedot0002")).status, 201);
  const third = await vote(design.body.sticky.id, "votedot0003");
  assert.equal(third.status, 409);
  assert.equal(third.body.error, "vote limit");
  assert.equal((await vote(hunt.body.sticky.id, "votedot0004")).status, 201);
  assert.equal((await vote(hunt.body.sticky.id, "votedot0005")).status, 409);
  const undo = await call(store, "/api/council/votes?session=test", {
    method: "DELETE",
    body: JSON.stringify({ participantId: PID }),
  });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.votes.channel, null);
  assert.equal((await vote(hunt.body.sticky.id, "votedot0006")).status, 201);
  const again = await vote(pm.body.sticky.id, "votedot0001");
  assert.equal(again.body.deduped, true);
});

test("ten stickies per column and twenty writes per minute are the caps", async () => {
  const store = memoryCouncilStore();
  for (let index = 0; index < 10; index += 1) {
    const created = await postSticky(store, { participantId: PID, column: "pm", text: `Skill ${index}`, clientId: `clientcap${index}x` });
    assert.equal(created.status, 201, String(index));
  }
  const capped = await postSticky(store, { participantId: PID, column: "pm", text: "one more", clientId: "clientcapover" });
  assert.equal(capped.status, 409);
  const other = await postSticky(store, { participantId: PID, column: "designer", text: "still ok", clientId: "clientcapdesi" });
  assert.equal(other.status, 201);
  let last = { status: 0, body: { error: "" } };
  for (let index = 0; index < 21; index += 1) {
    last = await call(store, "/api/council/votes?session=test", {
      method: "POST",
      body: JSON.stringify({ participantId: PID, stickyId: "missing01", clientId: `ratelimit${index}` }),
    });
  }
  assert.equal(last.status, 429);
  const otherIp = await call(
    store,
    "/api/council/votes?session=test",
    { method: "POST", body: JSON.stringify({ participantId: "otherperson", stickyId: "missing01", clientId: "rateother01" }) },
    { ip: "198.51.100.8" },
  );
  assert.notEqual(otherIp.status, 429);
  const later = await call(
    store,
    "/api/council/votes?session=test",
    { method: "POST", body: JSON.stringify({ participantId: PID, stickyId: "missing01", clientId: "ratelater01" }) },
    { now: 1_700_000_000_000 + 61_000 },
  );
  assert.notEqual(later.status, 429);
});

test("admin reset and seed stay inside one session and the live board refuses a non-empty seed", async () => {
  const store = memoryCouncilStore();
  await postSticky(store, { participantId: PID, column: "pm", text: "Keep me", clientId: "clientkeep01" }, "philly-2026-10-27");
  await postSticky(store, { participantId: PID, column: "pm", text: "Wipe me", clientId: "clientwipe01" }, "test");
  const noKey = await call(store, "/api/council/admin?session=test", {
    method: "POST",
    body: JSON.stringify({ action: "reset", sessionId: "test" }),
  }, { adminKey: "" });
  assert.equal(noKey.status, 403);
  const badKey = await call(store, "/api/council/admin?session=test&admin=nope", {
    method: "POST",
    body: JSON.stringify({ action: "reset", sessionId: "test" }),
  });
  assert.equal(badKey.status, 403);
  const missingBody = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "reset" }),
  });
  assert.equal(missingBody.status, 400);
  const crossed = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "reset", sessionId: "philly-2026-10-27" }),
  });
  assert.equal(crossed.status, 400);
  assert.equal((await call(store, "/api/council/state?session=test")).body.stickies.length, 1);
  const reset = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "reset", sessionId: "test" }),
  });
  assert.equal(reset.status, 200);
  assert.equal((await call(store, "/api/council/state?session=test")).body.stickies.length, 0);
  assert.equal((await call(store, "/api/council/state?session=philly-2026-10-27")).body.stickies[0].text, "Keep me");

  const blocked = await call(store, "/api/council/admin?session=philly-2026-10-27&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "seed", sessionId: "philly-2026-10-27" }),
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.warning, /empty/);
  assert.equal((await call(store, "/api/council/state?session=philly-2026-10-27")).body.stickies.length, 1);

  const seeded = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "seed", sessionId: "test" }),
  });
  assert.equal(seeded.status, 200);
  assert.equal(seeded.body.counts.pm, 10);
  assert.equal(seeded.body.counts.designer, 0);
  assert.equal(seeded.body.counts.channel, 10);
  assert.equal(seeded.body.counts.testing, 10);
  assert.equal(seeded.body.counts.harvest, 8);
  const wall = await call(store, "/api/council/state?session=test");
  assert.equal(wall.body.stickies.every((sticky: { demo: boolean }) => sticky.demo), true);
  assert.equal(wall.body.stickies.some((sticky: { column: string }) => sticky.column === "designer"), false);
  const votesOn = (column: string) =>
    wall.body.stickies
      .filter((sticky: { column: string }) => sticky.column === column)
      .reduce((sum: number, sticky: { votes: number }) => sum + sticky.votes, 0);
  assert.equal(votesOn("pm"), 12);
  assert.equal(votesOn("channel"), 6);
  assert.ok(wall.body.stickies.some((sticky: { column: string; votes: number }) => sticky.column === "pm" && sticky.votes > 0));
  assert.ok(wall.body.stickies.some((sticky: { column: string; today: { x: number } | null; year: { y: number } | null }) => sticky.column === "testing" && sticky.today && sticky.year));
  assert.equal((await call(store, "/api/council/state?session=philly-2026-10-27")).body.stickies.length, 1);

  const emptyLive = memoryCouncilStore();
  const allowed = await call(emptyLive, "/api/council/admin?session=philly-2026-10-27&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "seed", sessionId: "philly-2026-10-27" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.warning, "");
});

test("export requires the admin key and includes names, votes, and coordinates", async () => {
  const store = memoryCouncilStore();
  await postSticky(store, {
    participantId: PID,
    column: "testing",
    text: "Weekly calls",
    name: "Riley",
    clientId: "clienttest99",
    today: { x: 0.2, y: 0.3 },
    year: { x: 0.8, y: 0.9 },
    owner: "each PM",
  });
  const closed = await call(store, "/api/council/export?session=test&format=json");
  assert.equal(closed.status, 403);
  const exported = await call(store, "/api/council/export?session=test&format=json&admin=test-admin-key");
  assert.equal(exported.status, 200);
  assert.equal(exported.body.entries[0].author, "Riley");
  assert.equal(exported.body.entries[0].todayX, 0.2);
  assert.equal(exported.body.entries[0].yearY, 0.9);
  assert.ok(exported.body.entries[0].createdAt);
  const csv = await call(store, "/api/council/export?session=test&format=csv&admin=test-admin-key");
  assert.equal(csv.status, 200);
  assert.match(String(csv.body), /Weekly calls/);
  assert.match(String(csv.body), /0\.2/);
  const html = await call(store, "/api/council/export?session=test&format=html&admin=test-admin-key");
  assert.match(String(html.body), /Lines worth quoting/);
  assert.match(String(html.body), /Darren&#39;s next three moves/);
  await postSticky(store, { participantId: PID, column: "designer", text: "Ships UI", clientId: "clientdesig1" });
  const kept = await call(store, "/api/council/state?session=test");
  assert.ok(kept.body.stickies.some((sticky: { column: string; text: string }) => sticky.column === "designer" && sticky.text === "Ships UI"));
  const sheet = await call(store, "/api/council/export?session=test&format=html&admin=test-admin-key");
  assert.match(String(sheet.body), /PM skill cluster/);
  assert.equal(String(sheet.body).includes("Designer"), false);
  const dump = await call(store, "/api/council/export?session=test&format=json&admin=test-admin-key");
  assert.ok(dump.body.entries.some((entry: { column: string; text: string }) => entry.column === "designer" && entry.text === "Ships UI"));
  assert.equal(dump.body.capture.designer, undefined);
});

test("beat, vote, reveal, and merge stay on the server for one session", async () => {
  const store = memoryCouncilStore();
  const closed = await call(store, "/api/council/votes?session=test", {
    method: "POST",
    body: JSON.stringify({ participantId: PID, stickyId: "clientpm0001", clientId: "votedotclosed" }),
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, "voting closed");

  const phase = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", beat: 2, voteOpen: true, revealed: true, arrowsOn: false }),
  });
  assert.equal(phase.status, 200);
  const state = await call(store, "/api/council/state?session=test");
  assert.equal(state.body.meta.beat, 2);
  assert.equal(state.body.meta.voteOpen, true);
  assert.equal(state.body.meta.revealed, true);
  assert.equal(state.body.meta.arrowsOn, false);
  const live = await call(store, "/api/council/state?session=philly-2026-10-27");
  assert.equal(live.body.meta.beat, 1);
  assert.equal(live.body.meta.voteOpen, false);

  const first = await postSticky(store, { participantId: PID, column: "pm", text: "Ships prototypes", clientId: "clientmerge1" });
  const second = await postSticky(store, { participantId: PID, column: "pm", text: "Ships prototypes", clientId: "clientmerge2" });
  assert.equal(second.body.sticky.id, "clientmerge2");
  const stacked = await call(store, "/api/council/state?session=test");
  const child = stacked.body.stickies.find((sticky: { id: string }) => sticky.id === "clientmerge2");
  assert.equal(child.stackOf, first.body.sticky.id);
  const different = await postSticky(store, { participantId: PID, column: "pm", text: "Runs evals", clientId: "clientmerge3" });
  const merged = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "merge", parentId: first.body.sticky.id, childId: different.body.sticky.id }),
  });
  assert.equal(merged.status, 200);
  const split = await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "split", stickyId: different.body.sticky.id }),
  });
  assert.equal(split.status, 200);
  const after = await call(store, "/api/council/state?session=test");
  const detached = after.body.stickies.find((sticky: { id: string }) => sticky.id === "clientmerge3");
  assert.equal(detached.stackOf, null);
  assert.equal(detached.noAuto, true);
});

test("offline queue retries back off and does not enqueue the same client id twice", () => {
  const item = (id: string): QueueItem => ({
    id,
    kind: "sticky",
    url: "/api/council/stickies?session=test",
    method: "POST",
    body: { clientId: id },
    attempts: 0,
    nextAt: 1_000,
  });
  const once = enqueueItem([], item("clientqueue1"));
  assert.equal(enqueueItem(once, item("clientqueue1")).length, 1);
  assert.equal(retryDelayMs(0), 1_000);
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 4_000);
  assert.equal(retryDelayMs(3), 8_000);
  assert.equal(retryDelayMs(8), 30_000);
  const retried = markRetry(once[0], 5_000);
  assert.equal(retried.attempts, 1);
  assert.equal(retried.nextAt, 7_000);
  assert.equal(dueItems([retried], 6_999).length, 0);
  assert.equal(dueItems([retried], 7_000).length, 1);
  assert.equal((retried.body as { clientId: string }).clientId, "clientqueue1");
});

test("phone posts and votes retry a 5xx with the same client id", () => {
  const secret = "secret-token-xyz";
  const item: QueueItem = {
    id: "client-same-1",
    kind: "dot",
    url: "/api/council/votes?session=test",
    method: "POST",
    body: { participantId: PID, stickyId: "sticky1234", clientId: "client-same-1", note: secret },
    attempts: 0,
    nextAt: 0,
  };
  assert.equal(writeOutcome(201), "ok");
  assert.equal(writeOutcome(429), "retry");
  assert.equal(writeOutcome(500), "retry");
  assert.equal(writeOutcome(503), "retry");
  assert.equal(writeOutcome(409), "drop");
  assert.equal(writeOutcome(400), "drop");
  const again = markRetry(item, 1_000);
  assert.equal(again.id, item.id);
  assert.equal((again.body as { clientId: string }).clientId, "client-same-1");
  assert.equal(JSON.stringify(again.body), JSON.stringify(item.body));
  const join = readFileSync(new URL("../components/council/join-board.tsx", import.meta.url), "utf8");
  const send = join.slice(join.indexOf("async function send"), join.indexOf("async function post"));
  assert.match(send, /writeOutcome\(response\.status\)/);
  assert.match(send, /saving…/);
  assert.equal(send.includes("Still trying"), false);
  assert.match(send, /setError\("Voting closed\."\)/);
  const retryBranch = send.slice(send.indexOf('outcome === "retry"'), send.indexOf('outcome === "drop"'));
  assert.equal(retryBranch.includes("setError"), false);
  assert.match(retryBranch, /queueWrite\(item\)/);
});

test("a phone sticky write retries a 500 with the same client id and stores one item", async () => {
  const store = memoryCouncilStore();
  const clientId = "sameclient01";
  const posted: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/council/stickies") {
      posted.push(raw);
      if (posted.length === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "council failed" }));
        return;
      }
    }
    const response = await handleCouncil(
      new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
      }),
      deps(store, { ip: "203.0.113.77" }),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    const type = response.headers.get("content-type");
    if (type) headers["content-type"] = type;
    res.writeHead(response.status, headers);
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const body = { participantId: PID, column: "pm", text: "Retry the same note", name: "Quinn", clientId };
    const item: QueueItem = {
      id: clientId,
      kind: "sticky",
      url: `http://127.0.0.1:${address.port}/api/council/stickies?session=test`,
      method: "POST",
      body,
      attempts: 0,
      nextAt: 0,
    };
    const first = await fetch(item.url, {
      method: item.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item.body),
    });
    assert.equal(first.status, 500);
    assert.equal(writeOutcome(first.status), "retry");
    assert.equal((await store.list("test/sticky/")).length, 0);
    const queued = markRetry(item, 1_700_000_000_000);
    assert.equal(queued.id, clientId);
    assert.equal((queued.body as { clientId: string }).clientId, clientId);
    assert.equal(JSON.stringify(queued.body), JSON.stringify(item.body));
    const second = await fetch(queued.url, {
      method: queued.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(queued.body),
    });
    assert.equal(second.status, 201);
    assert.equal(writeOutcome(second.status), "ok");
    assert.deepEqual(posted.map((raw) => (JSON.parse(raw) as { clientId: string }).clientId), [clientId, clientId]);
    const keys = await store.list("test/sticky/");
    assert.equal(keys.length, 1);
    const stored = JSON.parse((await store.get(keys[0])) ?? "{}") as { id: string; clientId: string };
    assert.equal(stored.id, clientId);
    assert.equal(stored.clientId, clientId);
    const state = await fetch(`http://127.0.0.1:${address.port}/api/council/state?session=test`);
    assert.equal(state.status, 200);
    const board = (await state.json()) as { stickies: { id: string }[] };
    assert.equal(board.stickies.length, 1);
    assert.equal(board.stickies[0]?.id, clientId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed store keeps the last beat and backs off the poll", () => {
  const still = () => 0;
  assert.equal(reconnectDelayMs(1, still), 1_000);
  assert.equal(reconnectDelayMs(2, still), 2_000);
  assert.equal(reconnectDelayMs(3, still), 4_000);
  assert.equal(reconnectDelayMs(4, still), 8_000);
  assert.equal(reconnectDelayMs(5, still), 15_000);
  assert.equal(reconnectDelayMs(9, still), 15_000);
  assert.equal(reconnectDelayMs(1, () => 1), 1_200);
  assert.equal(reconnectDelayMs(4, () => 1), 9_000);
  assert.equal(reconnectDelayMs(5, () => 1), 14_000);
  assert.ok(reconnectDelayMs(9, () => 1) <= 15_000);
  const server: BeatMeta = { beat: 1, voteOpen: false, revealed: false, arrowsOn: true };
  const pending = nextBeatMeta(server, { beat: 2 });
  const held = resolveBeat(server, pending, null);
  assert.equal(held.meta.beat, 2);
  assert.equal(held.pending?.beat, 2);
  const echoed = resolveBeat({ ...server, beat: 2 }, pending, null);
  assert.equal(echoed.meta.beat, 2);
  assert.equal(echoed.pending, null);
  const acked = resolveBeat(server, null, pending);
  assert.equal(acked.meta.beat, 2);
  assert.equal(acked.acked?.beat, 2);
  const caughtUp = resolveBeat({ ...server, beat: 2 }, null, pending);
  assert.equal(caughtUp.acked, null);
  const deck = readFileSync(new URL("../components/council/deck.tsx", import.meta.url), "utf8");
  const join = readFileSync(new URL("../components/council/join-board.tsx", import.meta.url), "utf8");
  assert.match(deck, /pendingBeat/);
  assert.match(deck, /reconnectDelayMs\(failures\.current\)/);
  assert.match(deck, /failures\.current = 0/);
  assert.match(deck, /reconnecting…/);
  assert.match(deck, /applyLocal\(patch\)/);
  assert.match(join, /reconnectDelayMs\(failures\.current\)/);
  assert.match(join, /failures\.current = 0/);
});

test("blob retries stay short and log the error class without the message", async () => {
  const secret = "secret-token-xyz";
  const waits: number[] = [];
  const logs: string[] = [];
  const options = {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    log: (_level: "warn" | "error", line: string) => {
      logs.push(line);
    },
    jitter: () => 5,
  };
  let calls = 0;
  const value = await retryTransient("get", async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error(secret);
      error.name = "BlobRateLimited";
      throw Object.assign(error, { status: 429 });
    }
    return "ok";
  }, options);
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [45, 95]);
  assert.match(logs[0], /^council blob get failed HTTP 429$/);
  assert.equal(logs.join(" ").includes(secret), false);

  logs.length = 0;
  let rejected = 0;
  await assert.rejects(() =>
    retryTransient("set", async () => {
      rejected += 1;
      throw Object.assign(new Error(secret), { status: 400 });
    }, options),
  );
  assert.equal(rejected, 1);
  assert.equal(waits.length, 2);
  assert.match(logs[0], /HTTP 400|Error/);
  assert.equal(logs.join(" ").includes(secret), false);

  logs.length = 0;
  let blown = 0;
  await assert.rejects(() =>
    retryTransient("list", async () => {
      blown += 1;
      throw new TypeError(secret);
    }, options),
  );
  assert.equal(blown, 3);
  assert.equal(logs.length, 3);
  assert.match(logs[2], /^council blob list failed TypeError$/);
  assert.equal(logs.join(" ").includes(secret), false);
  assert.equal(isTransientBlobError(Object.assign(new Error("missing"), { name: "MissingBlobsEnvironmentError" })), false);
  assert.equal(isTransientBlobError(new Error("Refusing a council key that escapes the store")), false);
  assert.equal(blobFailureClass(new Error(secret)), "Error");

  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const boom: CouncilStore = {
      ...memoryCouncilStore(),
      async get() {
        throw new Error(secret);
      },
      async list() {
        throw Object.assign(new Error(secret), { name: "BlobRateLimited" });
      },
    };
    const response = await handleCouncil(new Request("https://marty.brelesky.com/api/council/state?session=test"), deps(boom));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, "council failed");
  } finally {
    console.error = original;
  }
  const logged = lines.join("\n");
  assert.equal(logged.includes(secret), false);
  assert.match(logged, /council failed BlobRateLimited|council failed Error/);
});

function expiredToken(): Error {
  const error = new Error("Netlify Blobs has generated an internal error (Failed to decode token: Token expired)");
  error.name = "BlobsInternalError";
  return Object.assign(error, { status: 401 });
}

function blobClient(get: () => Promise<unknown>) {
  return {
    get,
    async set() {
      return { modified: true };
    },
    async delete() {},
    async list() {
      return { blobs: [] as Array<{ key: string; etag: string }> };
    },
    async getWithMetadata() {
      return null;
    },
  };
}

test("each council request opens its own blob store", async () => {
  const source = readFileSync(new URL("./council/store.ts", import.meta.url), "utf8");
  assert.equal(source.includes("let cached"), false);
  const opens: number[] = [];
  let next = 0;
  const open = () => {
    next += 1;
    const id = next;
    opens.push(id);
    return blobClient(async () => `store-${id}`);
  };
  const first = councilStore(open);
  const second = councilStore(open);
  assert.notEqual(first, second);
  assert.deepEqual(opens, [1, 2]);
  assert.equal(await first.get("a"), "store-1");
  assert.equal(await second.get("b"), "store-2");
  assert.deepEqual(opens, [1, 2]);
});

test("an expired blob token is not retried on the same client", async () => {
  assert.equal(tokenExpired(expiredToken()), true);
  assert.equal(isTransientBlobError(expiredToken()), false);
  const gets: number[] = [];
  let next = 0;
  const open = () => {
    next += 1;
    const id = next;
    return blobClient(async () => {
      gets.push(id);
      if (id === 1) throw expiredToken();
      return `fresh-${id}`;
    });
  };
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const store = councilStore(open);
    assert.equal(await store.get("board"), "fresh-2");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(gets, [1, 2]);
  assert.equal(next, 2);
  assert.match(warnings[0] ?? "", /^council blob get failed HTTP 401$/);
  assert.equal(warnings.join(" ").includes("Token expired"), false);

  gets.length = 0;
  next = 0;
  const alwaysExpired = councilStore(() => {
    next += 1;
    const id = next;
    return blobClient(async () => {
      gets.push(id);
      throw expiredToken();
    });
  });
  await assert.rejects(() => alwaysExpired.get("board"));
  assert.deepEqual(gets, [1, 2]);
  assert.equal(next, 2);
});

test("a session outside the allowlist is not found", async () => {
  const store = memoryCouncilStore();
  assert.equal((await call(store, "/api/council/state")).status, 400);
  assert.equal((await call(store, "/api/council/state?session=workshop")).status, 404);
  const opened = await call(store, "/api/council/state?session=workshop", undefined, { sessions: ["workshop"] });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.sessionId, "workshop");
  assert.equal((await call(store, "/api/council/state?session=test", undefined, { sessions: ["workshop"] })).status, 404);
  assert.equal((await call(store, "/api/council/state?session=test", undefined, { sessions: [] })).status, 404);
  assert.equal(councilClientIp("203.0.113.8", "198.51.100.9, 10.0.0.4"), "203.0.113.8");
  assert.equal(councilClientIp(null, "198.51.100.9, 10.0.0.4"), "198.51.100.9");
  assert.equal(councilClientIp(null, null), "unknown");
});

test("writes are capped per IP and again per participant", async () => {
  const store = memoryCouncilStore();
  const hit = (ip: string, participantId: string, clientId: string) =>
    call(
      store,
      "/api/council/votes?session=test",
      { method: "POST", body: JSON.stringify({ participantId, stickyId: "missing01", clientId }) },
      { ip },
    );
  for (let index = 0; index < 20; index += 1) {
    const response = await hit("203.0.113.10", "personaaaa", `limita${index}xx`);
    assert.notEqual(response.status, 429, String(index));
  }
  assert.notEqual((await hit("203.0.113.10", "personbbbb", "limitb0001")).status, 429);
  assert.equal((await hit("198.51.100.20", "personaaaa", "limitc0001")).status, 429);
  assert.notEqual((await hit("198.51.100.20", "personbbbb", "limitd0001")).status, 429);
});

test("a post after the presenter leaves the beat is late, and phones are unique people", async () => {
  const store = memoryCouncilStore();
  const during = await postSticky(store, { participantId: PID, column: "pm", text: "On time", clientId: "clientlate01" });
  assert.equal(during.body.sticky.late, false);
  await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", beat: 4 }),
  });
  const late = await postSticky(store, { participantId: "personbbbb", column: "pm", text: "After", clientId: "clientlate02" });
  assert.equal(late.status, 201);
  assert.equal(late.body.sticky.late, true);
  const state = await call(store, "/api/council/state?session=test");
  assert.equal(state.body.stickies.find((sticky: { text: string }) => sticky.text === "After").late, true);
  assert.equal(state.body.phones, 2);
  assert.equal(JSON.stringify(state.body).includes(PID) , false);
});

test("the column cap counts the IP as well as the participant", async () => {
  const store = memoryCouncilStore();
  for (let index = 0; index < 10; index += 1) {
    const created = await postSticky(store, { participantId: "personaaaa", column: "channel", text: `Hunt ${index}`, clientId: `ipcap${index}xxxx` }, "test", { ip: "203.0.113.50" });
    assert.equal(created.status, 201, String(index));
  }
  const samePerson = await postSticky(store, { participantId: "personaaaa", column: "channel", text: "eleventh", clientId: "ipcapself01" }, "test", { ip: "203.0.113.50" });
  assert.equal(samePerson.status, 409);
  const sameIp = await postSticky(store, { participantId: "personbbbb", column: "channel", text: "one more", clientId: "ipcapover01" }, "test", { ip: "203.0.113.50" });
  assert.equal(sameIp.status, 201);
  const otherIp = await postSticky(store, { participantId: "personbbbb", column: "channel", text: "other network", clientId: "ipcapok0001" }, "test", { ip: "198.51.100.50" });
  assert.equal(otherIp.status, 201);
});

test("a venue IP keeps the personal caps and allows twelve people to post and vote", { timeout: 120_000 }, async () => {
  assert.equal(networkStickyCap(""), 200);
  assert.equal(networkStickyCap("15"), 15);
  assert.equal(networkStickyCap("nope"), 200);
  assert.equal(networkRateLimit(undefined), 400);
  assert.equal(networkRateLimit("20"), 20);
  assert.equal(pollDelayMs(0), 1_000);
  assert.equal(pollDelayMs(750), 250);
  assert.equal(pollDelayMs(800), 250);
  assert.equal(pollDelayMs(2_000), 250);

  const previousCap = process.env.COUNCIL_NETWORK_STICKY_CAP;
  const previousRate = process.env.COUNCIL_NETWORK_RATE_LIMIT;
  process.env.COUNCIL_NETWORK_STICKY_CAP = "10";
  process.env.COUNCIL_NETWORK_RATE_LIMIT = "20";
  try {
    const tight = memoryCouncilStore();
    for (let index = 0; index < 10; index += 1) {
      const created = await postSticky(tight, { participantId: "personaaaa", column: "designer", text: `Desk ${index}`, clientId: `tight${index}xxxx` }, "test", { ip: "203.0.113.90" });
      assert.equal(created.status, 201, String(index));
    }
    const blocked = await postSticky(tight, { participantId: "personbbbb", column: "designer", text: "network full", clientId: "tightover01" }, "test", { ip: "203.0.113.90" });
    assert.equal(blocked.status, 409);
    for (let index = 0; index < 20; index += 1) {
      const response = await call(tight, "/api/council/votes?session=test", {
        method: "POST",
        body: JSON.stringify({ participantId: "rateperson", stickyId: "missing01", clientId: `tightrate${index}` }),
      }, { ip: "203.0.113.91" });
      assert.notEqual(response.status, 429, String(index));
    }
    const rateBlocked = await call(tight, "/api/council/votes?session=test", {
      method: "POST",
      body: JSON.stringify({ participantId: "ratepersonb", stickyId: "missing01", clientId: "tightratexx" }),
    }, { ip: "203.0.113.91" });
    assert.equal(rateBlocked.status, 429);
  } finally {
    if (previousCap === undefined) delete process.env.COUNCIL_NETWORK_STICKY_CAP;
    else process.env.COUNCIL_NETWORK_STICKY_CAP = previousCap;
    if (previousRate === undefined) delete process.env.COUNCIL_NETWORK_RATE_LIMIT;
    else process.env.COUNCIL_NETWORK_RATE_LIMIT = previousRate;
  }

  const store = memoryCouncilStore();
  const venue = "203.0.113.80";
  const pm = await postSticky(store, { participantId: "targetpm01", column: "pm", text: "Vote skill", clientId: "targetpm01" }, "test", { ip: "198.51.100.9" });
  const design = await postSticky(store, { participantId: "targetde01", column: "designer", text: "Vote craft", clientId: "targetde01" }, "test", { ip: "198.51.100.9" });
  const hunt = await postSticky(store, { participantId: "targethu01", column: "channel", text: "Vote hunt", clientId: "targethu01" }, "test", { ip: "198.51.100.9" });
  assert.equal(pm.status, 201);
  assert.equal(design.status, 201);
  assert.equal(hunt.status, 201);
  await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", voteOpen: true }),
  });
  const jobs: Array<Promise<number>> = [];
  for (let person = 0; person < 12; person += 1) {
    const participantId = `room${String(person).padStart(4, "0")}xx`;
    for (let note = 0; note < 10; note += 1) {
      jobs.push(
        postSticky(
          store,
          { participantId, column: "pm", text: `Room ${person} note ${note}`, clientId: `room${person}n${note}xxx` },
          "test",
          { ip: venue },
        ).then((response) => response.status),
      );
    }
    const votes = [
      [pm.body.sticky.id, `room${person}va`],
      [design.body.sticky.id, `room${person}vb`],
      [hunt.body.sticky.id, `room${person}vc`],
    ] as const;
    for (const [stickyId, clientId] of votes) {
      jobs.push(
        call(
          store,
          "/api/council/votes?session=test",
          { method: "POST", body: JSON.stringify({ participantId, stickyId, clientId }) },
          { ip: venue },
        ).then((response) => response.status),
      );
    }
  }
  const statuses = await Promise.all(jobs);
  const failures = statuses.filter((status) => status !== 201);
  assert.equal(failures.length, 0, statuses.join(","));
  const extra = await postSticky(store, { participantId: "room0000xx", column: "pm", text: "over the personal ten", clientId: "roomextra01" }, "test", { ip: venue });
  assert.equal(extra.status, 409);
  const state = await call(store, "/api/council/state?session=test");
  assert.equal(state.body.stickies.length, 123);
  assert.equal(state.body.stickies.reduce((sum: number, sticky: { votes: number }) => sum + sticky.votes, 0), 36);
});

test("fifteen rapid votes on one phone still show all forty-five dots", { timeout: 60_000 }, async () => {
  const store = latentStore(memoryCouncilStore());
  const pm = await postSticky(store, { participantId: "tallypm0001", column: "pm", text: "Skill one", clientId: "tallypm0001" }, "test", { ip: "198.51.100.40" });
  const design = await postSticky(store, { participantId: "tallyde0001", column: "designer", text: "Skill two", clientId: "tallyde0001" }, "test", { ip: "198.51.100.40" });
  const hunt = await postSticky(store, { participantId: "tallyhu0001", column: "channel", text: "Hunt one", clientId: "tallyhu0001" }, "test", { ip: "198.51.100.40" });
  await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", voteOpen: true }),
  });
  const statuses = await Promise.all(
    Array.from({ length: 15 }, (_, person) => {
      const participantId = `fast${String(person).padStart(4, "0")}xx`;
      return Promise.all(
        [
          [pm.body.sticky.id, `fast${person}skilla`],
          [design.body.sticky.id, `fast${person}skillb`],
          [hunt.body.sticky.id, `fast${person}hunt00`],
        ].map(([stickyId, clientId]) =>
          call(
            store,
            "/api/council/votes?session=test",
            { method: "POST", body: JSON.stringify({ participantId, stickyId, clientId }) },
            { ip: "203.0.113.45" },
          ).then((response) => response.status),
        ),
      );
    }),
  );
  const flat = statuses.flat();
  assert.equal(flat.filter((status) => status !== 201).length, 0, flat.join(","));
  const state = await call(store, "/api/council/state?session=test");
  const shown = state.body.stickies.reduce((sum: number, sticky: { votes: number }) => sum + sticky.votes, 0);
  assert.equal(shown, 45, `board showed ${shown}`);
});

test("fifteen stickies on one IP finish with p95 under 1.5s", { timeout: 30_000 }, async () => {
  const store = latentStore(memoryCouncilStore());
  const samples: number[] = [];
  const statuses = await Promise.all(
    Array.from({ length: 15 }, async (_, index) => {
      const started = Date.now();
      const response = await postSticky(
        store,
        { participantId: `fastpost${String(index).padStart(2, "0")}x`, column: "pm", text: `Note ${index}`, clientId: `fastpost${index}xxx` },
        "test",
        { ip: "203.0.113.77" },
      );
      samples.push(Date.now() - started);
      return response.status;
    }),
  );
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
  assert.equal(statuses.filter((status) => status !== 201).length, 0, statuses.join(","));
  assert.ok(p95 < 1_500, `p95 ${p95}ms`);
});

test("forty people on one venue IP can each cast three votes within ten seconds", { timeout: 30_000 }, async () => {
  const store = memoryCouncilStore();
  const venue = "203.0.113.88";
  const pm = await postSticky(store, { participantId: "targetpm02", column: "pm", text: "Vote skill", clientId: "targetpm02" }, "test", { ip: "198.51.100.19" });
  const design = await postSticky(store, { participantId: "targetde02", column: "designer", text: "Vote craft", clientId: "targetde02" }, "test", { ip: "198.51.100.19" });
  const hunt = await postSticky(store, { participantId: "targethu02", column: "channel", text: "Vote hunt", clientId: "targethu02" }, "test", { ip: "198.51.100.19" });
  await call(store, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", voteOpen: true }),
  });
  const started = Date.now();
  const statuses = await Promise.all(
    Array.from({ length: 40 }, (_, person) => {
      const participantId = `vote${String(person).padStart(4, "0")}xx`;
      return Promise.all(
        [
          [pm.body.sticky.id, `v${person}skilla1`],
          [design.body.sticky.id, `v${person}skillb1`],
          [hunt.body.sticky.id, `v${person}hunt000`],
        ].map(([stickyId, clientId]) =>
          call(
            store,
            "/api/council/votes?session=test",
            { method: "POST", body: JSON.stringify({ participantId, stickyId, clientId }) },
            { ip: venue },
          ).then((response) => response.status),
        ),
      );
    }),
  );
  const elapsed = Date.now() - started;
  const flat = statuses.flat();
  assert.equal(flat.filter((status) => status !== 201).length, 0, flat.join(","));
  assert.ok(elapsed < 10_000, `votes took ${elapsed}ms`);
  const state = await call(store, "/api/council/state?session=test");
  assert.equal(state.body.stickies.reduce((sum: number, sticky: { votes: number }) => sum + sticky.votes, 0), 120);
});

test("the admin check confirms a key without echoing it", async () => {
  const store = memoryCouncilStore();
  const ok = await call(store, "/api/council/admin?session=test&admin=test-admin-key");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(JSON.stringify(ok.body).includes(KEY), false);
  const wrong = await call(store, "/api/council/admin?session=test&admin=not-the-key");
  assert.equal(wrong.status, 403);
  assert.equal(JSON.stringify(wrong.body).includes("not-the-key"), false);
  const missing = await call(store, "/api/council/admin?session=test");
  assert.equal(missing.status, 403);
  const page = readFileSync(new URL("../app/council/page.tsx", import.meta.url), "utf8");
  assert.equal(page.includes("adminKey"), false);
  assert.equal(page.includes("showAdmin"), false);
  const rendered = presenterAdminHandoff(new URL("https://marty.brelesky.com/council?session=test&admin=super-secret-admin-value"));
  assert.equal(rendered?.key, "super-secret-admin-value");
  assert.equal(rendered?.clean.searchParams.has("admin"), false);
  assert.equal(rendered?.clean.searchParams.get("session"), "test");
  assert.equal(presenterAdminHandoff(new URL("https://marty.brelesky.com/council?session=test")), null);
  assert.equal(presenterAdminHandoff(new URL("https://marty.brelesky.com/council/join?admin=super-secret-admin-value")), null);
});

test("a read never writes, and If-None-Match is 304", async () => {
  const store = memoryCouncilStore();
  const watched = countingStore(store);
  const empty = await handleCouncil(new Request("https://marty.brelesky.com/api/council/state?session=test"), deps(watched.store));
  assert.equal(empty.status, 200);
  assert.equal(watched.counts.sets, 0);
  assert.equal(watched.counts.deletes, 0);
  assert.equal((await empty.json()).stickies.length, 0);

  await postSticky(store, { participantId: PID, column: "pm", text: "One read", clientId: "clientetag01" });
  const reading = countingStore(store);
  const first = await handleCouncil(new Request("https://marty.brelesky.com/api/council/state?session=test"), deps(reading.store));
  assert.equal(first.status, 200);
  assert.equal(reading.counts.sets, 0);
  assert.equal(reading.counts.deletes, 0);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const body = await first.json();
  assert.equal(body.stickies[0].text, "One read");
  assert.equal(JSON.stringify(body).includes("\"ip\""), false);
  const second = await handleCouncil(
    new Request("https://marty.brelesky.com/api/council/state?session=test", { headers: { "if-none-match": etag ?? "" } }),
    deps(reading.store),
  );
  assert.equal(second.status, 304);
  assert.equal(reading.counts.sets, 0);
  assert.equal(await second.text(), "");
  assert.equal(first.headers.get("x-council-digest"), etag);
});

test("a weak If-None-Match, a validator list, and * are 304", async () => {
  const store = memoryCouncilStore();
  await postSticky(store, { participantId: PID, column: "pm", text: "Weak read", clientId: "clientweak01" });
  const reading = countingStore(store);
  const first = await handleCouncil(new Request("https://marty.brelesky.com/api/council/state?session=test"), deps(reading.store));
  const etag = first.headers.get("etag") ?? "";
  const digest = first.headers.get("x-council-digest") ?? "";
  assert.ok(etag);
  assert.equal(digest, etag);
  await first.json();

  async function poll(headers: Record<string, string>, path = "/api/council/state?session=test") {
    const response = await handleCouncil(new Request(`https://marty.brelesky.com${path}`, { headers }), deps(reading.store));
    assert.equal(reading.counts.sets, 0);
    assert.equal(reading.counts.deletes, 0);
    return response;
  }

  const weak = await poll({ "if-none-match": `W/${etag}` });
  assert.equal(weak.status, 304);
  assert.equal(await weak.text(), "");
  assert.equal(weak.headers.get("etag"), etag);
  assert.equal(weak.headers.get("x-council-digest"), digest);

  const lower = await poll({ "if-none-match": `w/${etag}` });
  assert.equal(lower.status, 304);
  assert.equal(await lower.text(), "");

  const list = await poll({ "if-none-match": `W/"stale-1", W/${etag}, "other-9"` });
  assert.equal(list.status, 304);
  assert.equal(await list.text(), "");

  const quotedComma = await poll({ "if-none-match": `W/"keep,this", ${etag}` });
  assert.equal(quotedComma.status, 304);

  const star = await poll({ "if-none-match": " *" });
  assert.equal(star.status, 304);
  assert.equal(await star.text(), "");

  const miss = await poll({ "if-none-match": 'W/"not-the-board"' });
  assert.equal(miss.status, 200);
  assert.equal((await miss.json()).stickies[0].text, "Weak read");

  const viaDigest = await poll({ "if-none-match": 'W/"rewritten-by-proxy"', "x-council-digest": `W/${digest}` });
  assert.equal(viaDigest.status, 304);
  assert.equal(await viaDigest.text(), "");

  const viaQuery = await poll({}, `/api/council/state?session=test&digest=${encodeURIComponent(digest)}`);
  assert.equal(viaQuery.status, 304);
  assert.equal(await viaQuery.text(), "");

  const wrongDigest = await poll({ "if-none-match": 'W/"rewritten-by-proxy"', "x-council-digest": 'W/"other"' });
  assert.equal(wrongDigest.status, 200);
});

test("presenter beats use the small QR, a 3-line clamp beside dots, and newest-first paging", () => {
  const css = readFileSync(new URL("../app/council/council.css", import.meta.url), "utf8");
  const deck = readFileSync(new URL("../components/council/deck.tsx", import.meta.url), "utf8");
  assert.match(css, /html\.council-page \.wall \.sticky \.txt\{[^}]*flex:\s*none/);
  assert.match(css, /html\.council-page \.wall \.sticky \.txt\{[^}]*line-clamp:\s*4/);
  assert.match(css, /html\.council-page \.wall \.sticky \.txt\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /html\.council-page \.wall \.sticky\{[^}]*word-break:\s*normal/);
  assert.match(css, /html\.council-page \.wall \.sticky\{[^}]*hyphens:\s*auto/);
  assert.match(css, /html\.council-page \.wall \.sticky\{[^}]*overflow-wrap:\s*break-word/);
  assert.match(css, /html\.council-page \.wall \.sticky\{[^}]*min-width:\s*0/);
  assert.match(css, /html\.council-page \.wall \.sticky \.txt\{[^}]*hyphens:\s*auto/);
  assert.match(css, /html\.council-page \.wall \.sticky \.txt\{[^}]*overflow-wrap:\s*break-word/);
  assert.match(css, /html\.council-page \.wall \.sticky:has\(\.dots,\.late-flag,\.rank\) \.txt\{[^}]*-webkit-line-clamp:\s*3/);
  assert.match(css, /html\.council-page \.rank\{[^}]*bottom:\s*8px;right:\s*8px/);
  assert.match(css, /html\.council-page \.votes\{[^}]*top:\s*8px;right:\s*8px/);
  assert.match(css, /html\.council-page \.kbd\{[^}]*font-size:\s*28px/);
  assert.match(css, /html\.council-page \.beat\{[^}]*font-size:\s*28px/);
  assert.match(css, /html\.council-page \.status\{[^}]*font-size:\s*28px/);
  assert.match(css, /html\.council-page \.wall \.sticky \.dots\{[^}]*flex:\s*none/);
  assert.equal(/html\.council-page \.wall \.sticky:has\(\.votes\) \.txt\{[^}]*padding/.test(css), false);
  assert.match(css, /html\.council-page \.stage:not\(\.beat-1\) \.join \.qr\{[^}]*width:\s*148px[^}]*height:\s*148px/);
  assert.match(css, /html\.council-page \.rail \.sticky\{[^}]*font-size:\s*28px/);
  assert.match(css, /html\.council-page \.harvest \.sticky \.by\{[^}]*font-size:\s*28px/);
  assert.match(css, /html\.council-page \.votes\{[^}]*font-size:\s*28px/);
  assert.match(css, /html\.council-page \.q-label\{[^}]*font:\s*500 28px/);
  assert.match(css, /html\.council-page \.more\{[^}]*white-space:\s*nowrap/);
  const join = readFileSync(new URL("../components/council/join-board.tsx", import.meta.url), "utf8");
  assert.match(css, /\.wall\{[^}]*grid-template-columns:\s*repeat\(2,\s*1fr\)/);
  assert.match(css, /\.seg\{[^}]*grid-template-columns:\s*repeat\(2,\s*1fr\)/);
  assert.match(deck, /\["pm", "PM skills", "var\(--s-butter\)"\]/);
  assert.match(deck, /\["channel", "Where to hunt", "var\(--s-mint\)"\]/);
  assert.equal(deck.includes("Designer skills"), false);
  assert.equal(join.includes("Designer skills"), false);
  assert.match(join, /label: "PM skills"/);
  assert.match(join, /label: "Where to hunt"/);
  assert.match(deck, /className=\{`stage beat-\$\{beat\}`\}/);
  assert.match(deck, /revealed \? groups : \[\.\.\.groups\]\.reverse\(\)/);
  assert.match(deck, /remainingStickies\(ordered\.length, start, shown\.length\)/);
  assert.match(deck, /card\.offsetHeight/);
  assert.match(deck, /stickyPages\(heights, height, buttonHeight, across\)/);
  assert.equal(/rowHeight = revealed &&/.test(deck), false);
  assert.equal(deck.includes("setPage(0)"), false);
});

test("the testing slide rail does not cover the 2x2 plot", () => {
  const css = readFileSync(new URL("../app/council/council.css", import.meta.url), "utf8");
  const rules = topLevelRules(css);
  const rail = cascaded(rules, "rail");
  const row = cascaded(rules, "board-row");
  const shift = cascaded(rules, "hand", (selector) => selector.split(",").some((part) => /\.rail\s+\.hand\s*$/.test(part.trim())));
  assert.equal(rail.get("position"), "relative");
  assert.equal(rail.get("right"), "auto");
  assert.equal(row.get("grid-template-columns")?.replace(/\s+/g, ""), "minmax(0,1fr)420px");
  assert.equal(shift.get("white-space"), "normal");
  assert.equal(shift.get("overflow-wrap"), "anywhere");
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1024, height: 768 },
  ]) {
    const overlap = testingRailOverlapPx(rail, row, viewport.width, viewport.height);
    assert.equal(overlap, 0, `${viewport.width}x${viewport.height} overlaps the plot by ${overlap}px`);
  }
});

function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Array<{ selector: string; body: string }> = [];
  let index = 0;
  while (index < clean.length) {
    const open = clean.indexOf("{", index);
    if (open < 0) break;
    const selector = clean.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < clean.length && depth > 0) {
      if (clean[cursor] === "{") depth += 1;
      else if (clean[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (selector && !selector.startsWith("@")) rules.push({ selector, body: clean.slice(open + 1, cursor - 1) });
    index = cursor;
  }
  return rules;
}

function cascaded(
  rules: Array<{ selector: string; body: string }>,
  className: string,
  match: (selector: string) => boolean = (selector) => selector.split(",").some((part) => new RegExp(`\\.${className}\\s*$`).test(part.trim())),
): Map<string, string> {
  const props = new Map<string, string>();
  for (const rule of rules) {
    if (!match(rule.selector)) continue;
    for (const part of rule.body.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (name && value) props.set(name, value);
    }
  }
  return props;
}

/** Stage pixels of rail-over-plot, scaled to the viewport. Relative `right` shifts the rail left across the gap. */
function testingRailOverlapPx(rail: Map<string, string>, row: Map<string, string>, viewportWidth: number, viewportHeight: number): number {
  const position = rail.get("position") ?? "static";
  const right = rail.get("right") ?? "auto";
  const offset = right === "auto" ? 0 : Number.parseFloat(right);
  const gap = Number.parseFloat(row.get("gap") ?? "0");
  const reserved = (row.get("grid-template-columns") ?? "").replace(/\s+/g, "") === "minmax(0,1fr)420px";
  let stageOverlap = 0;
  if (position === "absolute" || position === "fixed") stageOverlap = 420;
  else if (!reserved) stageOverlap = Math.max(0, offset);
  else stageOverlap = Math.max(0, offset - gap);
  const fit = Math.min(viewportWidth / 1920, viewportHeight / 1080);
  return Math.round(stageOverlap * fit);
}

test("concurrent posts and votes survive blob latency", { timeout: 120_000 }, async () => {
  const base = memoryCouncilStore();
  const store = latentStore(base);
  const columns = ["pm", "designer", "channel"] as const;
  for (const count of [20, 40]) {
    const session = count === 20 ? "test" : "workshop";
    const statuses = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        handleCouncil(
          new Request(`https://marty.brelesky.com/api/council/stickies?session=${session}`, {
            method: "POST",
            body: JSON.stringify({
              participantId: `person${String(index).padStart(4, "0")}x`,
              column: columns[index % 3],
              text: `idea number ${index}`,
              clientId: `client${String(count)}${String(index).padStart(5, "0")}`,
            }),
          }),
          { store, adminKey: KEY, now: 1_700_000_000_000, ip: `198.51.${count}.${index + 1}`, sessions: ["test", "workshop"] },
        ).then((response) => response.status),
      ),
    );
    assert.equal(statuses.filter((status) => status === 201).length, count, `posts ${count}: ${statuses.join(",")}`);
    const state = await handleCouncil(new Request(`https://marty.brelesky.com/api/council/state?session=${session}`), {
      store: base,
      adminKey: KEY,
      now: 1_700_000_000_000,
      ip: "203.0.113.9",
      sessions: ["test", "workshop"],
    });
    const body = (await state.json()) as { stickies: { text: string }[] };
    assert.equal(body.stickies.length, count);
  }

  await call(base, "/api/council/admin?session=test&admin=test-admin-key", {
    method: "POST",
    body: JSON.stringify({ action: "phase", voteOpen: true }),
  });
  const voters = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      handleCouncil(
        new Request("https://marty.brelesky.com/api/council/votes?session=test", {
          method: "POST",
          body: JSON.stringify({
            participantId: `person${String(index).padStart(4, "0")}x`,
            stickyId: `client20${String(index).padStart(5, "0")}`,
            clientId: `votedot${String(index).padStart(4, "0")}`,
          }),
        }),
        { store, adminKey: KEY, now: 1_700_000_000_000, ip: `203.0.113.${index + 1}`, sessions: ["test"] },
      ).then((response) => response.status),
    ),
  );
  assert.equal(voters.filter((status) => status === 201).length, 20, voters.join(","));
  const voted = await call(base, "/api/council/state?session=test");
  assert.equal(
    voted.body.stickies.reduce((sum: number, sticky: { votes: number }) => sum + sticky.votes, 0),
    20,
  );

  const limited = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      handleCouncil(
        new Request("https://marty.brelesky.com/api/council/votes?session=test", {
          method: "POST",
          body: JSON.stringify({
            participantId: "skilllimit",
            stickyId: index % 2 === 0 ? "client2000000" : "client2000001",
            clientId: `limitdot${index}xx`,
          }),
        }),
        { store, adminKey: KEY, now: 1_700_000_000_000, ip: "203.0.113.50", sessions: ["test"] },
      ).then((response) => response.status),
    ),
  );
  assert.equal(limited.filter((status) => status === 201).length, 2, limited.join(","));
  assert.equal(limited.filter((status) => status === 409).length, 3, limited.join(","));
  const capped = await call(base, "/api/council/state?session=test&p=skilllimit");
  assert.equal(capped.body.myVotes.skills.length, 2);

  const hunts = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      handleCouncil(
        new Request("https://marty.brelesky.com/api/council/votes?session=test", {
          method: "POST",
          body: JSON.stringify({
            participantId: "huntlimitx",
            stickyId: "client2000002",
            clientId: `huntdot${index}xxx`,
          }),
        }),
        { store, adminKey: KEY, now: 1_700_000_000_000, ip: "203.0.113.60", sessions: ["test"] },
      ).then((response) => response.status),
    ),
  );
  assert.equal(hunts.filter((status) => status === 201).length, 1, hunts.join(","));
  assert.equal(hunts.filter((status) => status === 409).length, 3, hunts.join(","));

  const crowded = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      handleCouncil(
        new Request("https://marty.brelesky.com/api/council/stickies?session=test", {
          method: "POST",
          body: JSON.stringify({
            participantId: "crowdperson",
            column: "pm",
            text: `crowd ${index}`,
            clientId: `crowdid${String(index).padStart(4, "0")}`,
          }),
        }),
        { store, adminKey: KEY, now: 1_700_000_000_000, ip: "203.0.113.70", sessions: ["test"] },
      ).then((response) => response.status),
    ),
  );
  assert.equal(crowded.filter((status) => status === 201).length, 10, crowded.join(","));
  assert.equal(crowded.filter((status) => status === 409).length, 2, crowded.join(","));
});

test("stickies shrink to fit, then page, and identical text clusters", () => {
  const comfortable = fitStickyLayout(21, 520, 640);
  assert.ok(comfortable.pageSize < 21);
  assert.ok(comfortable.pageSize >= 1);
  assert.equal(comfortable.font, 28);
  const wall = fitStickyLayout(58, 520, 620);
  assert.equal(wall.font, 28);
  assert.ok(wall.pageSize < 58);
  const dozen = fitStickyLayout(12, 900, 700);
  assert.ok(dozen.font >= 28);
  const crowded = fitStickyLayout(80, 400, 280);
  assert.ok(crowded.pageSize < 80);
  assert.equal(crowded.font, 28);
  const wide = fitStickyLayout(8, 520, 640);
  assert.equal(wide.across, 2);
  assert.equal(comfortable.across, 2);
  assert.equal(wall.across, 2);
  assert.equal(fitStickyLayout(40, 520, 700).across, 2);
  const tall = fitStickyLayout(20, 520, 640, 250);
  assert.equal(tall.across, 2);
  assert.equal(tall.font, 28);
  assert.equal(tall.pageSize, 3);
  assert.ok(fitStickyLayout(20, 520, 640).pageSize > tall.pageSize);
  assert.equal(fitStickyLayout(2, 520, 640, 250).pageSize, 2);
  assert.equal(fitStickyLayout(60, 480, 700, 248).pageSize < 60, true);
  const variable = fitStickyLayout(45, 520, 640, 180);
  assert.ok(variable.pageSize < fitStickyLayout(45, 520, 640).pageSize);
  assert.equal(variable.pageSize < 45, true);
  assert.equal(remainingStickies(45, 0, variable.pageSize), 45 - variable.pageSize);
  assert.equal(remainingStickies(45, variable.pageSize, variable.pageSize), 45 - variable.pageSize * 2);
  assert.equal(remainingStickies(45, 42, 3), 0);
  const plain = stickyPages(Array.from({ length: 20 }, () => 121), 640);
  assert.equal(plain[0], 8);
  assert.ok(plain[0] > fitStickyLayout(20, 520, 640, 193).pageSize);
  const mixed = stickyPages([193, 121, 121, 121, 121, 121, 121, 121, 121, 121, 121, 121], 640);
  assert.equal(mixed[0], 7);
  assert.equal(stickyPages([100, 100], 640).length, 1);
  const groups = clusterGroups(
    [
      { id: "aaaaaaaa", column: "pm", text: "Ships prototypes", stackOf: null, hidden: false, createdAt: "1", noAuto: false },
      { id: "bbbbbbbb", column: "pm", text: "ships prototypes", stackOf: null, hidden: false, createdAt: "2", noAuto: false },
      { id: "cccccccc", column: "pm", text: "ships prototypes", stackOf: null, hidden: false, createdAt: "3", noAuto: true },
    ],
    "pm",
    () => 1,
    false,
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].members.length, 2);
});

test("council routes stay public and the blob store is council-vote", () => {
  const middleware = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(middleware, /presenterAdminHandoff/);
  assert.equal(middleware.includes("decideRequestAccess"), false);
  assert.equal(middleware.includes("basic-auth"), false);
  const source = readFileSync(new URL("./council/store.ts", import.meta.url), "utf8");
  assert.match(source, /council-vote/);
  assert.equal(source.includes("mc-marty-council"), false);
  assert.equal(source.includes("mc-marty-data"), false);
  assert.equal(source.includes("kanban"), false);
  const route = readFileSync(new URL("../app/api/council/[[...path]]/route.ts", import.meta.url), "utf8");
  assert.equal(route.includes("COUNCIL_ADMIN_KEY"), false);
  assert.equal(route.includes("COUNCIL_SESSIONS"), false);
});
