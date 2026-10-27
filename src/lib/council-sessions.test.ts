import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleCouncil } from "./council/http.ts";
import { requestOrigin } from "./council/origin.ts";
import { memoryCouncilStore, type CouncilStore } from "./council/store.ts";

const CREATOR = "creator-secret-value";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function call(store: CouncilStore, path: string, init?: RequestInit, creatorKey = CREATOR) {
  return handleCouncil(new Request(`https://example.test${path}`, init), {
    store,
    creatorKey,
    now: 1_700_000_000_000,
    ip: "203.0.113.10",
  });
}

async function create(store: CouncilStore, body: Record<string, unknown>, init?: RequestInit) {
  const response = await call(store, "/api/council/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${CREATOR}`, "content-type": "application/json", ...init?.headers },
    body: JSON.stringify(body),
    ...init,
  });
  const payload = (await response.json()) as {
    slug: string;
    title: string;
    adminKey: string;
    presenterUrl: string;
    joinUrl: string;
    adminUrl: string;
    content: { title: string; columns: { pm: string }; beats: { prompt: string }[] };
    error?: string;
  };
  return { status: response.status, payload };
}

test("creating a session returns one admin key and stores only its hash", async () => {
  const store = memoryCouncilStore();
  const made = await create(store, {
    slug: "alpha",
    title: "Alpha council",
    columns: { pm: "Alpha skills" },
    beats: [{ n: 1, prompt: "Opening line for alpha" }],
  });
  assert.equal(made.status, 201);
  assert.equal(made.payload.slug, "alpha");
  assert.equal(made.payload.title, "Alpha council");
  assert.match(made.payload.adminKey, /^[0-9a-f]{64}$/);
  assert.match(made.payload.presenterUrl, /\/council\?session=alpha$/);
  assert.match(made.payload.joinUrl, /\/council\/join\?session=alpha$/);
  assert.match(made.payload.adminUrl, /admin=/);
  assert.equal(made.payload.content.columns.pm, "Alpha skills");
  assert.equal(made.payload.content.beats[0]?.prompt, "Opening line for alpha");
  const stored = await store.get("registry/alpha");
  assert.equal(stored?.includes(made.payload.adminKey), false);
  assert.match(stored ?? "", /"adminKeyHash":"[0-9a-f]{64}"/);
  const state = await call(store, "/api/council/state?session=alpha");
  const board = (await state.json()) as { content: { title: string; columns: { pm: string } } };
  assert.equal(state.status, 200);
  assert.equal(board.content.title, "Alpha council");
  assert.equal(board.content.columns.pm, "Alpha skills");
});

test("session A's admin key cannot run or export session B", async () => {
  const store = memoryCouncilStore();
  const alpha = await create(store, { slug: "alpha", title: "Alpha" });
  const bravo = await create(store, { slug: "bravo", title: "Bravo" });
  assert.equal(alpha.status, 201);
  assert.equal(bravo.status, 201);
  const posted = await call(store, "/api/council/stickies?session=bravo", {
    method: "POST",
    body: JSON.stringify({ participantId: "personbravo", column: "pm", text: "Bravo only", clientId: "clientbravo1" }),
  });
  assert.equal(posted.status, 201);

  const crossed = await call(store, `/api/council/admin?session=bravo&admin=${alpha.payload.adminKey}`, {
    method: "POST",
    body: JSON.stringify({ action: "reset", sessionId: "bravo" }),
  });
  assert.equal(crossed.status, 403);
  const exported = await call(store, `/api/council/export?session=bravo&format=json&admin=${alpha.payload.adminKey}`);
  assert.equal(exported.status, 403);
  const fixture = await handleCouncil(new Request(`https://example.test/api/council/admin?session=alpha&admin=test-admin-key`), {
    store,
    adminKey: "test-admin-key",
    creatorKey: CREATOR,
    now: 1_700_000_000_000,
    ip: "203.0.113.10",
    sessions: ["alpha", "bravo"],
  });
  assert.equal(fixture.status, 403);

  const own = await call(store, `/api/council/admin?session=alpha&admin=${alpha.payload.adminKey}`, {
    method: "POST",
    body: JSON.stringify({ action: "reset", sessionId: "alpha" }),
  });
  assert.equal(own.status, 200);
  const kept = await store.get("registry/alpha");
  assert.match(kept ?? "", /Alpha/);
  const bravoState = await call(store, "/api/council/state?session=bravo");
  const bravoBody = (await bravoState.json()) as { stickies: { text: string }[] };
  assert.deepEqual(bravoBody.stickies.map((sticky) => sticky.text), ["Bravo only"]);

  const sheet = await call(store, `/api/council/export?session=bravo&format=json&admin=${bravo.payload.adminKey}`);
  assert.equal(sheet.status, 200);
  const dump = (await sheet.json()) as { entries: { text: string }[] };
  assert.equal(dump.entries[0]?.text, "Bravo only");
});

test("the creator key gates create and list, and a query string is ignored", async () => {
  const store = memoryCouncilStore();
  const missing = await handleCouncil(new Request("https://example.test/api/council/sessions", { method: "POST", body: "{}" }), {
    store,
    now: 1_700_000_000_000,
    ip: "203.0.113.10",
  });
  assert.equal(missing.status, 403);
  assert.equal(((await missing.json()) as { error: string }).error, "creator disabled");

  const wrong = await call(store, "/api/council/sessions", {
    method: "POST",
    headers: { authorization: "Bearer nope" },
    body: JSON.stringify({ slug: "alpha", title: "Alpha" }),
  });
  assert.equal(wrong.status, 403);

  const fromQuery = await call(store, `/api/council/sessions?creator=${CREATOR}`, {
    method: "POST",
    body: JSON.stringify({ slug: "alpha", title: "Alpha", creatorKey: CREATOR }),
  });
  assert.equal(fromQuery.status, 403);

  const header = await call(store, "/api/council/sessions", {
    method: "POST",
    headers: { "x-council-creator": CREATOR, "content-type": "application/json" },
    body: JSON.stringify({ slug: "nope!", title: "Broken" }),
  });
  assert.equal(header.status, 400);

  const made = await create(store, { slug: "alpha", title: "Alpha council" });
  assert.equal(made.status, 201);
  const again = await create(store, { slug: "alpha", title: "Alpha council" });
  assert.equal(again.status, 409);

  const list = await call(store, "/api/council/sessions", { headers: { authorization: `Bearer ${CREATOR}` } });
  const listed = (await list.json()) as { sessions: Array<Record<string, string>> };
  assert.equal(list.status, 200);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.slug, "alpha");
  assert.equal(JSON.stringify(listed).includes(made.payload.adminKey), false);
  assert.equal(JSON.stringify(listed).includes("adminKey"), false);
});

test("export uses the session copy and the other key is refused", async () => {
  const store = memoryCouncilStore();
  const made = await create(store, { slug: "alpha", title: "Alpha council", captureMoves: "Tommy's next three moves" });
  const html = await call(store, `/api/council/export?session=alpha&format=html&admin=${made.payload.adminKey}`);
  const sheet = await html.text();
  assert.equal(html.status, 200);
  assert.match(sheet, /Tommy&#39;s next three moves/);
  assert.equal(sheet.includes("Darren"), false);
  assert.match(html.headers.get("content-disposition") ?? "", /capture-sheet-alpha\.html/);
  const csv = await call(store, `/api/council/export?session=alpha&format=csv&admin=${made.payload.adminKey}`);
  assert.match(csv.headers.get("content-disposition") ?? "", /council-alpha\.csv/);
});

test("a session created with no content has no Darren string", async () => {
  const store = memoryCouncilStore();
  const made = await create(store, { slug: "plain", title: "Tuesday council" });
  assert.equal(made.status, 201);
  const stored = JSON.parse((await store.get("registry/plain")) ?? "{}") as { content: unknown };
  assert.equal(JSON.stringify(stored.content).includes("Darren"), false);
  assert.equal(JSON.stringify(made.payload).includes("Darren"), false);
  const state = await call(store, "/api/council/state?session=plain");
  const board = (await state.json()) as { content: unknown };
  assert.equal(JSON.stringify(board.content).includes("Darren"), false);
  const html = await call(store, `/api/council/export?session=plain&format=html&admin=${made.payload.adminKey}`);
  assert.equal((await html.text()).includes("Darren"), false);

  const named = await create(store, { slug: "scripted", title: "Tuesday council", template: "product-council" });
  assert.equal(named.status, 201);
  const script = JSON.parse((await store.get("registry/scripted")) ?? "{}") as { content: { capture: { moves: string } } };
  assert.match(script.content.capture.moves, /Darren/);
  const unknown = await create(store, { slug: "nope", title: "Nope", template: "other" });
  assert.equal(unknown.status, 400);
});

test("a missing host falls back to localhost", () => {
  assert.equal(requestOrigin(null, null), "http://localhost:3000");
  assert.equal(requestOrigin("not a host", null), "http://localhost:3000");
});

test("the create-session CLI calls the deployed API", async () => {
  const store = memoryCouncilStore();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const host = req.headers.host ?? "127.0.0.1";
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handleCouncil(request, {
      store,
      creatorKey: CREATOR,
      now: 1_700_000_000_000,
      ip: "127.0.0.1",
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await runCli("scripts/create-session.ts", ["--slug", "cli-room", "--title", "CLI council", "--pm", "CLI skills"], {
      COUNCIL_BASE_URL: base,
      COUNCIL_CREATOR_KEY: CREATOR,
    });
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stderr.includes(CREATOR), false);
    const payload = JSON.parse(created.stdout) as { slug: string; adminKey: string; content: { columns: { pm: string } } };
    assert.equal(payload.slug, "cli-room");
    assert.equal(payload.content.columns.pm, "CLI skills");
    assert.equal(created.stdout.includes("Darren"), false);
    const scripted = await runCli(
      "scripts/create-session.ts",
      ["--slug", "cli-script", "--title", "Scripted council", "--template", "product-council"],
      { COUNCIL_BASE_URL: base, COUNCIL_CREATOR_KEY: CREATOR },
    );
    assert.equal(scripted.code, 0, scripted.stderr);
    assert.match(scripted.stdout, /Darren/);
    const listed = await runCli("scripts/list-sessions.ts", [], { COUNCIL_BASE_URL: base, COUNCIL_CREATOR_KEY: CREATOR });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /cli-room/);
    assert.equal(listed.stdout.includes(payload.adminKey), false);
    const exported = await runCli("scripts/export-session.ts", ["--slug", "cli-room", "--admin-key", payload.adminKey, "--format", "json"], {
      COUNCIL_BASE_URL: base,
      COUNCIL_CREATOR_KEY: "not-used-for-export",
    });
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /cli-room/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("implementation files do not name a single tenant or the old store", () => {
  const forbidden = ["philly-2026-10-27", "mc-marty-council", "COUNCIL_ADMIN_KEY", "COUNCIL_SESSIONS"];
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].filter((file) => !file.endsWith(".test.ts"));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${path.relative(ROOT, file)} contains ${token}`);
    }
  }
});

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "fonts" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|css)$/.test(name)) files.push(full);
  }
  return files;
}

function runCli(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
