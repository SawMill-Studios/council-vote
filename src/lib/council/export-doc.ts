import { quadrantName, stackGroups } from "./group.ts";
import { csvCell, escapeHtml } from "./text.ts";
import { defaultBoardCopy, type BoardCopy } from "./template.ts";
import type { Dot, Meta, Sticky } from "./types.ts";

export interface ExportBundle {
  json: string;
  csv: string;
  html: string;
  filenameStem: string;
}

export function buildExport(input: {
  sessionId: string;
  exportedAt: string;
  meta: Meta;
  stickies: readonly Sticky[];
  votes: readonly { participantId: string; dots: Dot[] }[];
  content?: BoardCopy;
}): ExportBundle {
  const content = input.content ?? defaultBoardCopy();
  const dots = input.votes.flatMap((vote) => vote.dots.map((dot) => ({ ...dot, participantId: vote.participantId })));
  const votesFor = voteMap(dots);
  const entries = input.stickies.map((sticky) => ({
    id: sticky.id,
    sessionId: input.sessionId,
    column: sticky.column,
    text: sticky.text,
    author: sticky.author,
    showName: sticky.showName,
    participantId: sticky.participantId,
    late: sticky.late,
    hidden: sticky.hidden,
    votes: votesFor.get(sticky.id) ?? 0,
    createdAt: sticky.createdAt,
    updatedAt: sticky.updatedAt,
    todayX: sticky.today?.x ?? "",
    todayY: sticky.today?.y ?? "",
    yearX: sticky.year?.x ?? "",
    yearY: sticky.year?.y ?? "",
    owner: sticky.owner,
    cadence: sticky.cadence,
    tools: sticky.tools,
    ai: sticky.ai,
    stackOf: sticky.stackOf ?? "",
    label: sticky.label,
  }));
  const capture = captureSections(input.stickies, votesFor);
  const json = JSON.stringify(
    {
      sessionId: input.sessionId,
      exportedAt: input.exportedAt,
      beat: input.meta.beat,
      voteOpen: input.meta.voteOpen,
      revealed: input.meta.revealed,
      entries,
      capture,
    },
    null,
    2,
  );
  return {
    json,
    csv: toCsv(entries),
    html: captureHtml(capture, content),
    filenameStem: `council-${input.sessionId}`,
  };
}

function voteMap(dots: readonly { stickyId: string }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const dot of dots) map.set(dot.stickyId, (map.get(dot.stickyId) ?? 0) + 1);
  return map;
}

function captureSections(stickies: readonly Sticky[], votesFor: Map<string, number>) {
  const visible = stickies.filter((sticky) => !sticky.hidden);
  const pm = ranked(visible, "pm", votesFor, 4);
  const channels = ranked(visible, "channel", votesFor, 12).map((row) => ({
    ...row,
    who: row.showName ? row.author : "",
  }));
  const testing = visible
    .filter((sticky) => sticky.column === "testing" && sticky.today && sticky.year)
    .map((sticky) => ({
      name: sticky.author,
      quadrants: `${quadrantName(sticky.today!.x, sticky.today!.y)} / ${quadrantName(sticky.year!.x, sticky.year!.y)}`,
      owner: sticky.owner,
      cadence: sticky.cadence,
      tools: sticky.tools,
      ai: sticky.ai,
    }));
  const offers = visible
    .filter((sticky) => sticky.column === "harvest")
    .map((sticky) => ({ name: sticky.author, offer: sticky.text }));
  return { pm, channels, testing, offers };
}

function ranked(stickies: readonly Sticky[], column: Sticky["column"], votesFor: Map<string, number>, limit: number) {
  return stackGroups(stickies, column, (id) => votesFor.get(id) ?? 0, true)
    .slice(0, limit)
    .map((group) => ({
      text: group.root.label || group.root.text,
      votes: group.votes,
      author: group.root.author,
      showName: group.root.showName,
    }));
}

function toCsv(entries: readonly Record<string, string | number | boolean>[]): string {
  const headers = [
    "id",
    "sessionId",
    "column",
    "text",
    "author",
    "showName",
    "participantId",
    "late",
    "hidden",
    "votes",
    "createdAt",
    "updatedAt",
    "todayX",
    "todayY",
    "yearX",
    "yearY",
    "owner",
    "cadence",
    "tools",
    "ai",
    "stackOf",
    "label",
  ];
  const lines = [headers.join(",")];
  for (const entry of entries) {
    lines.push(headers.map((header) => csvCell(String(entry[header] ?? ""))).join(","));
  }
  return lines.join("\n");
}

function cell(value: string): string {
  return `<td>${escapeHtml(value)}</td>`;
}

function rows(items: readonly string[][], width: number): string {
  const padded = items.length > 0 ? items : [Array.from({ length: width }, () => "")];
  return padded
    .map((item, index) => `<tr><td class="n">${index + 1}</td>${item.map((part) => cell(part)).join("")}</tr>`)
    .join("");
}

function captureHtml(capture: ReturnType<typeof captureSections>, content: BoardCopy): string {
  const pm = capture.pm.map((row) => [row.text, String(row.votes)]);
  const channels = capture.channels.map((row) => [row.text, row.who, String(row.votes), ""]);
  const testing = capture.testing.map((row) => [row.name, row.quadrants, row.owner, row.cadence, row.tools, row.ai]);
  const offers = capture.offers.map((row) => [row.name, row.offer, ""]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(content.capture.heading)}</title>
<style>
@page { size: letter; margin: 0.4in; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Inter","DejaVu Sans",sans-serif; color:#111; font-size: 10pt; }
h1 { font-size: 17pt; font-weight: 800; }
.sub { color:#666; font-size: 9.5pt; margin: 2px 0 10px; }
h2 { font-size: 11pt; font-weight: 800; color:#0A5CFF; text-transform: uppercase; letter-spacing:.06em; margin: 7px 0 3px; }
table { width:100%; border-collapse: collapse; table-layout: fixed; }
html,body { width: 7.7in; }
td, th { border: 1px solid #bbb; padding: 3px 6px; height: 19px; vertical-align: top; text-align: left; }
th { background:#f2f2f2; font-size: 9pt; font-weight:700; height: auto; }
.row { display:flex; gap: 10px; }
.row > div { flex:1; }
.box { border:1px solid #bbb; height: 44px; padding: 3px 6px; color:#888; font-size: 9pt; }
.n { width: 30px; text-align:center; color:#888; }
.dots { width: 52px; }
</style></head><body>
<h1>${escapeHtml(content.capture.heading)}</h1>
<div class="sub">${escapeHtml(content.capture.sub)}</div>
<h2>1. Hiring: skills (top clusters + dot count)</h2>
<table><tr><th class="n">#</th><th>${escapeHtml(content.capture.pmHeading)}</th><th class="dots">Dots</th></tr>${rows(pm, 2)}</table>
<h2>2. Hiring: where to hunt</h2>
<table><tr><th>Channel</th><th style="width:150px">Who said it</th><th class="dots">Dots</th><th style="width:170px">Intro or link offered?</th></tr>
${channels.length ? channels.map((row) => `<tr>${row.map((part) => cell(part)).join("")}</tr>`).join("") : "<tr><td></td><td></td><td></td><td></td></tr>"}
</table>
<h2>3. Testing: where each team sits on the 2x2</h2>
<table><tr><th style="width:95px">Name</th><th style="width:90px">Quadrant now / in a year</th><th>Owner</th><th>Cadence</th><th>Tools</th><th>What AI does</th></tr>
${testing.length ? testing.map((row) => `<tr>${row.map((part) => cell(part)).join("")}</tr>`).join("") : "<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>"}
</table>
<div class="row" style="margin-top:6px"><div class="box">Center of excellence or every PM? Room's lean and why:</div><div class="box">Contractor to stand it up? Yes / no, and what they must leave behind:</div></div>
<h2>4. Lines worth quoting</h2>
<table><tr><th style="width:120px">Who</th><th>What they said</th></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>
<h2>5. "I'll give you ___" (commitments)</h2>
<table><tr><th style="width:120px">Name</th><th>Offer (intro, channel, template, call)</th><th style="width:110px">By when</th></tr>
${offers.length ? offers.map((row) => `<tr>${row.map((part) => cell(part)).join("")}</tr>`).join("") : "<tr><td></td><td></td><td></td></tr>"}
</table>
<h2>6. ${escapeHtml(content.capture.moves)}</h2>
<table><tr><td>1.</td></tr><tr><td>2.</td></tr><tr><td>3.</td></tr></table>
</body></html>`;
}
