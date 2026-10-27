import { baseUrl, fail, flag, loadLocalEnv } from "./cli-env.ts";

loadLocalEnv();

const slug = flag("slug");
const title = flag("title");
if (!slug || !title) {
  fail("Usage: npm run create-session -- --slug my-session --title \"My council\" [--template product-council] [--pm \"PM skills\"] [--channel \"Where to hunt\"] [--prompt \"Opening line\"] [--capture-moves \"Next three moves\"]");
}

const creatorKey = process.env.COUNCIL_CREATOR_KEY ?? "";
if (!creatorKey) fail("Set COUNCIL_CREATOR_KEY. It creates sessions. It is not an admin key.");

const body: Record<string, unknown> = { slug, title };
const template = flag("template");
if (template) body.template = template;
const pm = flag("pm");
const channel = flag("channel");
const testing = flag("testing");
const harvest = flag("harvest");
if (pm || channel || testing || harvest) {
  body.columns = {
    ...(pm ? { pm } : {}),
    ...(channel ? { channel } : {}),
    ...(testing ? { testing } : {}),
    ...(harvest ? { harvest } : {}),
  };
}
const prompt = flag("prompt");
if (prompt) body.beats = [{ n: 1, prompt }];
const captureMoves = flag("capture-moves");
if (captureMoves) body.captureMoves = captureMoves;

const response = await fetch(`${baseUrl()}/api/council/sessions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${creatorKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});
const text = await response.text();
if (!response.ok) {
  let message = `Create failed (${response.status})`;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) message = parsed.error;
  } catch {
    /* The body is not JSON. */
  }
  fail(message);
}
process.stdout.write(`${text}\n`);
