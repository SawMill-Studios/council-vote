import { writeFileSync } from "node:fs";
import { baseUrl, fail, flag, loadLocalEnv } from "./cli-env.ts";

loadLocalEnv();

const slug = flag("slug");
const adminKey = flag("admin-key");
const format = flag("format") ?? "json";
const out = flag("out");
if (!slug || !adminKey) {
  fail("Usage: npm run export-session -- --slug my-session --admin-key PASTE --format json|csv|html [--out file]");
}
if (format !== "json" && format !== "csv" && format !== "html") fail("format must be json, csv, or html");

const url = new URL("/api/council/export", `${baseUrl()}/`);
url.searchParams.set("session", slug);
url.searchParams.set("admin", adminKey);
url.searchParams.set("format", format);
const response = await fetch(url);
const text = await response.text();
if (!response.ok) {
  let message = `Export failed (${response.status})`;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) message = parsed.error;
  } catch {
    /* The body is not JSON. */
  }
  fail(message);
}
if (out) writeFileSync(out, text);
else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
