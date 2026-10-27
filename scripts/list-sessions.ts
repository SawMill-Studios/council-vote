import { baseUrl, fail, loadLocalEnv } from "./cli-env.ts";

loadLocalEnv();

const creatorKey = process.env.COUNCIL_CREATOR_KEY ?? "";
if (!creatorKey) fail("Set COUNCIL_CREATOR_KEY.");

const response = await fetch(`${baseUrl()}/api/council/sessions`, {
  headers: { authorization: `Bearer ${creatorKey}` },
});
const text = await response.text();
if (!response.ok) {
  let message = `List failed (${response.status})`;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) message = parsed.error;
  } catch {
    /* The body is not JSON. */
  }
  fail(message);
}
process.stdout.write(`${text}\n`);
