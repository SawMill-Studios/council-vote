import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fitStickyLayout, stickyPages, tiltFor } from "./council/group.ts";

const CSS = new URL("../app/council/council.css", import.meta.url);
const SENTENCE = "Help the team catch switchers from ops without asking.";
const LONG_TOKEN = "Supercalifragilisticexpialidocioushiringtokenx";
const VIEWPORTS = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1366", width: 1366, height: 768 },
  { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 },
] as const;

test("revealed hiring wall keeps ranks, badges, and lines inside the card", { timeout: 60_000 }, async () => {
  const html = await writeBoard();
  const chrome = await launchChrome();
  try {
    await chrome.open(html);
    for (const viewport of VIEWPORTS) {
      const report = await chrome.measure(viewport.width, viewport.height);
      assert.equal(report.total, 40, viewport.name);
      assert.equal(report.revealed, true, viewport.name);
      assert.ok(report.shown >= 6, `${viewport.name} showed ${report.shown}`);
      assert.equal(report.wrap, "break-word", viewport.name);
      assert.equal(report.wordBreak, "normal", viewport.name);
      assert.equal(report.hyphens, "auto", viewport.name);
      assert.ok(report.fonts.kbd >= 28, `${viewport.name} kbd ${report.fonts.kbd}`);
      assert.ok(report.fonts.beat >= 28, `${viewport.name} beat ${report.fonts.beat}`);
      assert.ok(report.fonts.status >= 28, `${viewport.name} status ${report.fonts.status}`);
      assert.ok(report.fonts.votes >= 28, `${viewport.name} votes ${report.fonts.votes}`);
      assert.equal(report.clamp, "3", viewport.name);
      assert.equal(report.spacedLines.every((count) => count === 3), true, `${viewport.name} lines ${report.spacedLines.join(",")}`);
      assert.equal(report.partials, 0, `${viewport.name} partial lines ${report.partials}`);
      assert.equal(
        report.failures.length,
        0,
        `${viewport.name}\n${report.failures.join("\n")}`,
      );
    }
  } finally {
    await chrome.close();
  }
});

test("the phone 2x2 plot stays square and the presenter plot keeps its inset", { timeout: 60_000 }, async () => {
  const html = await writePlotBoard();
  const chrome = await launchChrome();
  try {
    await chrome.open(html);
    const boxes = await chrome.evalAt<{
      phone: PlotBox;
      presenter: PlotBox;
    }>(375, 812, "window.plotBoxes()");
    assert.ok(Math.abs(boxes.phone.plotW - 331) < 2, `phone plot ${boxes.phone.plotW}`);
    assert.ok(Math.abs(boxes.phone.plotH - boxes.phone.plotW) < 2, `phone plot ${boxes.phone.plotW}x${boxes.phone.plotH}`);
    assert.ok(Math.abs(boxes.phone.svgW - boxes.phone.plotW) < 2, `phone svg ${boxes.phone.svgW}x${boxes.phone.svgH}`);
    assert.ok(Math.abs(boxes.phone.svgH - boxes.phone.plotH) < 2, `phone svg ${boxes.phone.svgW}x${boxes.phone.svgH}`);
    assert.ok(Math.abs(boxes.presenter.svgW - (boxes.presenter.plotW - 48)) < 2, `presenter svg width ${boxes.presenter.svgW} plot ${boxes.presenter.plotW}`);
    assert.ok(Math.abs(boxes.presenter.svgH - (boxes.presenter.plotH - 212)) < 2, `presenter svg height ${boxes.presenter.svgH} plot ${boxes.presenter.plotH}`);
    assert.ok(Math.abs(boxes.presenter.top - 88) < 2, `presenter svg top ${boxes.presenter.top}`);
    assert.ok(Math.abs(boxes.presenter.left - 24) < 2, `presenter svg left ${boxes.presenter.left}`);
  } finally {
    await chrome.close();
  }
});

test("the phone column picker stays visible on short screens", { timeout: 60_000 }, async () => {
  const html = await writePickerBoard();
  const chrome = await launchChrome();
  try {
    await chrome.open(html);
    for (const viewport of [
      { width: 390, height: 664 },
      { width: 375, height: 667 },
      { width: 360, height: 640 },
    ]) {
      const box = await chrome.evalAt<{
        height: number;
        overflow: string;
        flexShrink: string;
        buttons: number[];
        count: number;
      }>(viewport.width, viewport.height, "window.pickerBox()");
      assert.ok(box.height >= 52, `${viewport.width}x${viewport.height} picker ${box.height}`);
      assert.equal(box.overflow, "visible", `${viewport.width}x${viewport.height}`);
      assert.equal(box.flexShrink, "0", `${viewport.width}x${viewport.height}`);
      assert.equal(box.count, 2);
      assert.equal(box.buttons.length, 2);
      for (const height of box.buttons) {
        assert.ok(height >= 44, `${viewport.width}x${viewport.height} button ${height}`);
      }
    }
  } finally {
    await chrome.close();
  }
});

async function writePickerBoard(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-picker-"));
  const file = join(dir, "picker.html");
  const html = `<!doctype html>
<html lang="en" class="council-page">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${CSS.href}" />
<style>
html,body{height:100%;margin:0}
.seg{display:inline-flex;overflow:hidden}
.seg button{height:28px}
</style>
</head>
<body>
  <main class="phone" style="height:100dvh;overflow:hidden">
    <div style="height:120px">top</div>
    <div class="tabs"><button type="button">Hiring</button><button type="button">2x2</button></div>
    <p class="ph-beat">Hiring wall</p>
    <h1 class="ph-title">Hire for what?</h1>
    <div class="seg" role="group" aria-label="Which column">
      <button type="button">PM skills</button>
      <button type="button">Where to hunt</button>
    </div>
    <div class="compose" style="min-height:140px">compose</div>
    <button class="btn" type="button">Post</button>
    <div style="height:240px">below</div>
  </main>
<script>
window.pickerBox = function pickerBox() {
  const seg = document.querySelector(".phone .seg");
  const style = getComputedStyle(seg);
  const buttons = [...seg.querySelectorAll("button")].map((button) => button.getBoundingClientRect().height);
  return { height: seg.getBoundingClientRect().height, overflow: style.overflow, flexShrink: style.flexShrink, buttons, count: buttons.length };
};
</script>
</body>
</html>`;
  await writeFile(file, html);
  return file;
}

async function writePlotBoard(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-plot-"));
  const file = join(dir, "plot.html");
  const svg = `<svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none"><rect x="2" y="2" width="96" height="96" fill="#FBF4E6" stroke="#2B2118" stroke-width="1.2"></rect></svg>`;
  const html = `<!doctype html>
<html lang="en" class="council-page">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${CSS.href}" />
<style>html,body{overflow:hidden}</style>
</head>
<body>
  <div class="phone">
    <div class="plot">${svg}</div>
  </div>
  <div class="stage-frame" style="--fit:1">
    <div class="stage-sizer">
      <main class="stage beat-3">
        <div class="board">
          <div class="board-row">
            <div class="plot">${svg}</div>
            <aside class="rail"></aside>
          </div>
        </div>
      </main>
    </div>
  </div>
<script>
function plotBox(plot) {
  const svg = plot.querySelector("svg");
  const host = plot.getBoundingClientRect();
  const mark = svg.getBoundingClientRect();
  return { plotW: host.width, plotH: host.height, svgW: mark.width, svgH: mark.height, top: mark.top - host.top, left: mark.left - host.left };
}
window.plotBoxes = function plotBoxes() {
  return { phone: plotBox(document.querySelector(".phone .plot")), presenter: plotBox(document.querySelector(".stage .plot")) };
};
</script>
</body>
</html>`;
  await writeFile(file, html);
  return file;
}

interface PlotBox {
  plotW: number;
  plotH: number;
  svgW: number;
  svgH: number;
  top: number;
  left: number;
}

test("revealed stickies do not overlap at any presenter size", { timeout: 60_000 }, async () => {
  const chrome = await launchChrome();
  try {
    for (const total of [30, 60]) {
      const html = await writeVotedBoard(total / 2);
      await chrome.open(html);
      for (const viewport of VIEWPORTS) {
        const metrics = await chrome.evalAt<{ cardHeight: number; gridWidth: number; gridHeight: number; perColumn: number }>(
          viewport.width,
          viewport.height,
          "window.metrics()",
        );
        assert.ok(metrics.cardHeight >= 200, `${viewport.name} card ${metrics.cardHeight}`);
        const fit = fitStickyLayout(metrics.perColumn, metrics.gridWidth, metrics.gridHeight, metrics.cardHeight);
        const packed = await chrome.evalAt<{ shown: number; extra: number; hitCount: number; hits: string[] }>(
          viewport.width,
          viewport.height,
          `window.apply(${fit.pageSize})`,
        );
        assert.equal(packed.shown, fit.pageSize * 2, `${viewport.name} ${total}`);
        assert.ok(packed.extra > 0, `${viewport.name} ${total} hid none`);
        assert.equal(packed.hitCount, 0, `${viewport.name} ${total}\n${packed.hits.join("\n")}`);
      }
    }
  } finally {
    await chrome.close();
  }
});

test("unrevealed stickies do not overlap or clip a line on any page", { timeout: 120_000 }, async () => {
  const html = await writeUnrevealedBoard();
  const chrome = await launchChrome();
  try {
    await chrome.open(html);
    for (const viewport of VIEWPORTS) {
      const metrics = await chrome.evalAt<UnrevealedColumn[]>(viewport.width, viewport.height, "window.columnMetrics()");
      assert.deepEqual(metrics.map((column) => column.count), [45, 35], viewport.name);
      const plans = metrics.map((column) => {
        assert.equal(column.heights.length, column.count, viewport.name);
        assert.ok(column.heights.every((height) => height >= 48), `${viewport.name} heights ${column.heights.join(",")}`);
        const packed = stickyPages(column.heights, column.gridHeight, column.buttonHeight);
        assert.equal(packed.reduce((sum, count) => sum + count, 0), column.count, viewport.name);
        assert.ok(packed[0] >= 1 && packed[0] < column.count, `${viewport.name} first page ${packed[0]}`);
        return packed;
      });
      const pages = Math.max(...plans.map((packed) => packed.length));
      for (let page = 0; page < pages; page += 1) {
        const report = await chrome.evalAt<UnrevealedPage>(
          viewport.width,
          viewport.height,
          `window.showPage(${JSON.stringify(plans)}, ${page})`,
        );
        assert.equal(report.hitCount, 0, `${viewport.name} page ${page}\n${report.hits.join("\n")}`);
        assert.equal(report.partials, 0, `${viewport.name} page ${page} partials ${report.partials}`);
        assert.equal(report.outside, 0, `${viewport.name} page ${page} outside ${report.outside}`);
        assert.equal(report.midWords, 0, `${viewport.name} page ${page} mid-word ${report.midWords}`);
        assert.equal(report.wrap, "break-word", viewport.name);
        assert.equal(report.hyphens, "auto", viewport.name);
        assert.equal(report.revealed, false, viewport.name);
        report.columns.forEach((column, index) => {
          const counts = plans[index];
          const start = counts.slice(0, page).reduce((sum, count) => sum + count, 0);
          const shown = Math.max(0, Math.min(counts[page] ?? 0, column.count - start));
          const remaining = Math.max(0, column.count - start - shown);
          assert.equal(column.shown, shown, `${viewport.name} page ${page} column ${index}`);
          assert.equal(column.remaining, remaining, `${viewport.name} page ${page} column ${index} remaining`);
          assert.equal(column.label, remaining > 0 ? `+${remaining} more` : "", `${viewport.name} page ${page} column ${index} label`);
          if (viewport.name === "1920" && remaining > 0) {
            assert.ok(column.fill >= 0.8, `${viewport.name} page ${page} column ${index} fill ${column.fill}`);
          }
        });
      }
    }
  } finally {
    await chrome.close();
  }
});

async function writeUnrevealedBoard(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-unrevealed-"));
  const file = join(dir, "board.html");
  const counts = [
    ["pm", 45],
    ["channel", 35],
  ] as const;
  const texts = [
    "Hire",
    SENTENCE,
    "Help the team catch switchers from ops without asking them to leave the channel they already trust, then write the note so the room can rank the work.",
    `${LONG_TOKEN} ${SENTENCE}`,
  ];
  const cards = counts
    .map(([column, count]) => {
      const notes = Array.from({ length: count }, (_, index) => {
        const id = `${column}${String(index).padStart(2, "0")}note`;
        return `<article class="sticky butter" style="--r:${tiltFor(id)}deg"><div class="txt">${texts[index % texts.length]}</div></article>`;
      }).join("");
      return `<section class="col" data-column="${column}"><div class="colh"><span class="chip"></span>${column}<span class="n">${count}</span></div><div class="grid" style="--across:2">${notes}<button class="btn alt more" type="button">+0 more</button></div></section>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="en" class="council-page">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${CSS.href}" />
</head>
<body>
<div class="stage-frame" style="--fit:1">
  <div class="stage-sizer">
    <main class="stage beat-2" data-revealed="false">
      <header class="hdr"><div class="main"><div class="beat">Hiring</div><h1 class="title">Hiring</h1></div></header>
      <div class="board"><div class="wall" data-total="80">${cards}</div></div>
      <footer class="foot"><div><span class="kbd">N</span> page</div><div class="status">2 / 4</div></footer>
    </main>
  </div>
</div>
<script>
const wall = document.querySelector(".wall");
const snapshot = wall.innerHTML;
function fitScale() {
  document.querySelector(".stage-frame").style.setProperty("--fit", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
}
function columnWidth(grid) {
  const style = getComputedStyle(grid);
  const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const gap = Number.parseFloat(style.columnGap);
  return (grid.clientWidth - padX - (Number.isFinite(gap) ? gap : 12)) / 2;
}
function measureColumn(grid) {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;left:0;top:0;display:flex;flex-direction:column;";
  probe.style.width = columnWidth(grid) + "px";
  grid.appendChild(probe);
  const heights = [];
  for (const card of [...grid.querySelectorAll(".sticky")]) {
    const clone = card.cloneNode(true);
    clone.style.width = "100%";
    probe.appendChild(clone);
    heights.push(clone.offsetHeight);
    clone.remove();
  }
  const more = grid.querySelector(".more");
  let buttonHeight = 52;
  if (more) {
    const clone = more.cloneNode(true);
    probe.appendChild(clone);
    buttonHeight = clone.offsetHeight + (Number.parseFloat(getComputedStyle(clone).marginTop) || 0);
    clone.remove();
  }
  probe.remove();
  return { heights, buttonHeight };
}
window.columnMetrics = function columnMetrics() {
  wall.innerHTML = snapshot;
  fitScale();
  return [...wall.querySelectorAll(".grid")].map((grid) => {
    const style = getComputedStyle(grid);
    const pad = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const measured = measureColumn(grid);
    return {
      count: grid.querySelectorAll(".sticky").length,
      heights: measured.heights,
      buttonHeight: measured.buttonHeight,
      gridWidth: grid.clientWidth,
      gridHeight: Math.max(40, grid.clientHeight - pad),
    };
  });
};
window.showPage = function showPage(plans, page) {
  wall.innerHTML = snapshot;
  fitScale();
  const columns = [];
  const grids = [...wall.querySelectorAll(".grid")];
  grids.forEach((grid, index) => {
    const counts = plans[index] || [];
    const pageSize = counts[page] || 0;
    const stickies = [...grid.querySelectorAll(".sticky")];
    const count = stickies.length;
    const start = counts.slice(0, page).reduce((sum, count) => sum + count, 0);
    const keep = new Set(stickies.slice(start, start + pageSize));
    for (const node of stickies) if (!keep.has(node)) node.remove();
    const shown = grid.querySelectorAll(".sticky").length;
    const remaining = Math.max(0, count - start - shown);
    const more = grid.querySelector(".more");
    if (more) {
      if (remaining > 0) more.textContent = "+" + remaining + " more";
      else more.remove();
    }
    const labelNode = grid.querySelector(".more");
    columns.push({ count, pageSize, shown, remaining, label: labelNode ? labelNode.textContent : "", fill: 0 });
  });
  const boxes = [...wall.querySelectorAll(".sticky, .more")].map((node) => node.getBoundingClientRect());
  const hits = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.width < 1 || b.width < 1) continue;
      if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
        hits.push(Math.round(a.left) + "," + Math.round(a.top) + " " + Math.round(a.width) + "x" + Math.round(a.height) + " ~ " + Math.round(b.left) + "," + Math.round(b.top));
      }
    }
  }
  for (const sticky of wall.querySelectorAll(".sticky")) sticky.style.transform = "none";
  let partials = 0;
  let midWords = 0;
  let outside = 0;
  for (const grid of grids) {
    const host = grid.getBoundingClientRect();
    for (const node of grid.querySelectorAll(".sticky, .more")) {
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.left < host.left - 1 || box.right > host.right + 1 || box.top < host.top - 1 || box.bottom > host.bottom + 1) outside += 1;
    }
    for (const txt of grid.querySelectorAll(".txt")) {
      partials += partialCount(txt);
      if (midWord(txt.textContent || "", visibleLines(txt))) midWords += 1;
    }
    const padTop = Number.parseFloat(getComputedStyle(grid).paddingTop) || 0;
    const padBottom = Number.parseFloat(getComputedStyle(grid).paddingBottom) || 0;
    const available = grid.clientHeight - padTop - padBottom;
    const nodes = [...grid.querySelectorAll(".sticky, .more")];
    if (nodes.length && available > 0) {
      const top = Math.min(...nodes.map((node) => node.getBoundingClientRect().top));
      const bottom = Math.max(...nodes.map((node) => node.getBoundingClientRect().bottom));
      columns[grids.indexOf(grid)].fill = (bottom - top) / available;
    }
  }
  const sample = wall.querySelector(".txt");
  const style = sample ? getComputedStyle(sample) : { overflowWrap: "", hyphens: "" };
  return {
    hitCount: hits.length,
    hits: hits.slice(0, 8),
    partials,
    outside,
    midWords,
    wrap: style.overflowWrap,
    hyphens: style.hyphens,
    revealed: document.querySelector(".stage").dataset.revealed === "true",
    columns,
  };
};
function laidLines(el) {
  const node = [...el.childNodes].find((item) => item.nodeType === 3);
  if (!node) return [];
  const text = node.textContent || "";
  const host = el.getBoundingClientRect();
  const range = document.createRange();
  const lines = [];
  let line = null;
  for (let index = 0; index < text.length; index += 1) {
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!line || Math.abs(rect.top - line.top) > 2) {
      line = { top: rect.top, bottom: rect.bottom, height: rect.height, text: text[index], end: index + 1 };
      lines.push(line);
    } else {
      line.text += text[index];
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.height = Math.max(line.height, rect.height);
      line.end = index + 1;
    }
  }
  for (const row of lines) {
    const overlap = Math.min(row.bottom, host.bottom) - Math.max(row.top, host.top);
    row.visible = overlap >= row.height * 0.8;
    row.partial = overlap > 2 && overlap < row.height * 0.8;
  }
  return lines;
}
function visibleLines(el) {
  return laidLines(el).filter((line) => line.visible);
}
function partialCount(el) {
  return laidLines(el).filter((line) => line.partial).length;
}
function midWord(text, lines) {
  for (const line of lines) {
    const next = text[line.end];
    const endChar = line.text.at(-1) || "";
    if (!next || /\\s/.test(next) || /\\s/.test(endChar)) continue;
    if (endChar === "-" || endChar === "\\u00ad") continue;
    const head = text.slice(0, line.end).split(/\\s/).pop() || "";
    const rest = text.slice(line.end).split(/\\s/)[0] || "";
    if ((head + rest).length >= 20) continue;
    return line.text + "…";
  }
  return "";
}
</script>
</body>
</html>`;
  await writeFile(file, html);
  return file;
}

interface UnrevealedColumn {
  count: number;
  heights: number[];
  buttonHeight: number;
  gridWidth: number;
  gridHeight: number;
}

interface UnrevealedPage {
  hitCount: number;
  hits: string[];
  partials: number;
  outside: number;
  midWords: number;
  wrap: string;
  hyphens: string;
  revealed: boolean;
  columns: { count: number; pageSize: number; shown: number; remaining: number; label: string; fill: number }[];
}

async function writeVotedBoard(perColumn: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-overlap-"));
  const file = join(dir, "board.html");
  const columns = ["pm", "channel"] as const;
  const cards = columns
    .map((column) => {
      const notes = Array.from({ length: perColumn }, (_, index) => {
        const votes = perColumn - index;
        const rank = index < 3 ? index + 1 : 0;
        const id = `${column}${String(index).padStart(2, "0")}voted`;
        const dots = "<span class=\"dot\"></span>".repeat(Math.min(votes, 8));
        return `<article class="sticky butter" style="--r:${tiltFor(id)}deg">${votes ? `<span class="votes">${votes}</span>` : ""}${
          rank ? `<span class="rank">${rank}</span>` : ""
        }<div class="txt">${SENTENCE}</div><div class="dots">${dots}</div></article>`;
      }).join("");
      return `<section class="col"><div class="colh"><span class="chip"></span>${column}<span class="n">${perColumn}</span></div><div class="grid" style="--across:2">${notes}<button class="btn alt more" type="button">+0 more</button></div></section>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="en" class="council-page">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${CSS.href}" />
</head>
<body>
<div class="stage-frame" style="--fit:1">
  <div class="stage-sizer">
    <main class="stage beat-2" data-revealed="true">
      <header class="hdr"><div class="main"><div class="beat">Hiring · Ranked</div><h1 class="title">Hiring</h1></div></header>
      <div class="board"><div class="wall" data-total="${perColumn * 2}">${cards}</div></div>
      <footer class="foot"><div><span class="kbd">→</span> beats</div><div class="status">2 / 4</div></footer>
    </main>
  </div>
</div>
<script>
const wall = document.querySelector(".wall");
const snapshot = wall.innerHTML;
function fitScale() {
  document.querySelector(".stage-frame").style.setProperty("--fit", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
}
window.metrics = function metrics() {
  wall.innerHTML = snapshot;
  fitScale();
  const grid = wall.querySelector(".grid");
  const card = grid.querySelector(".sticky");
  const style = getComputedStyle(grid);
  const pad = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return {
    cardHeight: card.offsetHeight,
    gridWidth: grid.clientWidth,
    gridHeight: Math.max(40, grid.clientHeight - pad),
    perColumn: grid.querySelectorAll(".sticky").length,
  };
};
window.apply = function apply(pageSize) {
  wall.innerHTML = snapshot;
  fitScale();
  let shown = 0;
  let extra = 0;
  for (const grid of wall.querySelectorAll(".grid")) {
    const stickies = [...grid.querySelectorAll(".sticky")];
    const more = grid.querySelector(".more");
    const keep = Math.max(0, Math.min(pageSize, stickies.length));
    for (const node of stickies.slice(keep)) node.remove();
    const left = stickies.length - keep;
    extra += left;
    shown += grid.querySelectorAll(".sticky").length;
    if (more) {
      if (left > 0) more.textContent = "+" + left + " more";
      else more.remove();
    }
  }
  const boxes = [...wall.querySelectorAll(".sticky")].map((node) => node.getBoundingClientRect());
  const hits = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.width < 1 || b.width < 1) continue;
      if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
        hits.push(Math.round(a.left) + "," + Math.round(a.top) + " " + Math.round(a.width) + "x" + Math.round(a.height) + " ~ " + Math.round(b.left) + "," + Math.round(b.top));
      }
    }
  }
  return { shown, extra, hitCount: hits.length, hits: hits.slice(0, 6) };
};
</script>
</body>
</html>`;
  await writeFile(file, html);
  return file;
}

async function writeBoard(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-revealed-"));
  const file = join(dir, "board.html");
  const columns = ["pm", "channel"] as const;
  const cards = columns
    .map((column) => {
      const notes = Array.from({ length: 20 }, (_, index) => {
        const votes = 20 - index;
        const rank = index < 3 ? index + 1 : 0;
        const text = column === "channel" && index === 0 ? LONG_TOKEN : SENTENCE;
        const dots = "<span class=\"dot\"></span>".repeat(Math.min(votes, 8));
        return `<article class="sticky butter" data-column="${column}" data-rank="${rank}" style="font-size:28px">${
          votes ? `<span class="votes">${votes}</span>` : ""
        }${rank ? `<span class="rank">${rank}</span>` : ""}<div class="txt">${text}</div><div class="dots">${dots}</div></article>`;
      }).join("");
      return `<section class="col" data-column="${column}"><div class="colh"><span class="chip"></span>${column}<span class="n">20</span></div><div class="grid" style="--across:2">${notes}<button class="btn alt more" type="button">+0 more</button></div></section>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="en" class="council-page">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${CSS.href}" />
</head>
<body>
<div class="stage-frame" style="--fit:1">
  <div class="stage-sizer">
    <main class="stage beat-2" data-revealed="true">
      <header class="hdr">
        <div class="main">
          <div class="beat">Hiring · Ranked</div>
          <h1 class="title">Hiring</h1>
          <p class="prompt">What should we hire for?</p>
        </div>
        <div class="join"><div class="qr"></div><div><div class="url"><small>Join on your phone.</small>marty.brelesky.com</div><div class="live"><span class="pulse"></span>60 phones</div></div></div>
      </header>
      <div class="board"><div class="wall" data-total="40">${cards}</div></div>
      <footer class="foot"><div><span class="kbd">→</span> beats</div><div class="status">2 / 4</div></footer>
    </main>
  </div>
</div>
<script>
const wall = document.querySelector(".wall");
const snapshot = wall.innerHTML;
window.measure = function measure() {
  wall.innerHTML = snapshot;
  const failures = [];
  let shown = 0;
  for (const grid of wall.querySelectorAll(".grid")) {
    const stickies = [...grid.querySelectorAll(".sticky")];
    const more = grid.querySelector(".more");
    while (stickies.length > 3 && grid.scrollHeight > grid.clientHeight + 1) stickies.pop().remove();
    if (more) more.textContent = "+" + (20 - grid.querySelectorAll(".sticky").length) + " more";
    while (grid.scrollHeight > grid.clientHeight + 1 && grid.querySelectorAll(".sticky").length > 3) {
      const last = grid.querySelector(".sticky:last-of-type");
      if (!last) break;
      last.remove();
    }
    shown += grid.querySelectorAll(".sticky").length;
  }
  for (const sticky of wall.querySelectorAll(".sticky")) sticky.style.transform = "none";
  const spacedLines = [];
  let partials = 0;
  for (const column of wall.querySelectorAll(".col")) {
    for (const el of column.querySelectorAll("*")) {
      const sticky = el.closest(".sticky");
      if (sticky && el !== sticky) {
        const out = edges(el, sticky, 1);
        if (out.length) failures.push((el.className || el.tagName) + " outside sticky " + out.join("+"));
      }
      const colOut = edges(el, column, 1);
      if (colOut.length) failures.push((el.className || el.tagName) + " outside column " + column.dataset.column + " " + colOut.join("+"));
    }
    for (const txt of column.querySelectorAll(".txt")) {
      const lines = visibleLines(txt);
      const text = txt.textContent || "";
      const rankedOrDotted = txt.closest(".sticky")?.querySelector(".rank, .dots, .late-flag");
      if (rankedOrDotted && lines.length > 3) failures.push("lines " + lines.length + " " + text.slice(0, 24));
      if (text.includes(" ")) spacedLines.push(lines.length);
      partials += partialCount(txt);
      const broken = midWord(text, lines);
      if (broken) failures.push("mid-word " + broken);
    }
  }
  const sample = wall.querySelector(".txt");
  const style = getComputedStyle(sample);
  const ranked = wall.querySelector(".sticky[data-rank='1'] .txt");
  const px = (selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
  return {
    total: Number(wall.dataset.total),
    revealed: document.querySelector(".stage").dataset.revealed === "true",
    shown,
    wrap: style.overflowWrap,
    wordBreak: style.wordBreak,
    hyphens: style.hyphens,
    fonts: { kbd: px(".kbd"), beat: px(".beat"), status: px(".status"), votes: px(".votes") },
    spacedLines,
    partials,
    failures: failures.slice(0, 16),
    clamp: getComputedStyle(ranked).webkitLineClamp,
  };
};
function edges(child, parent, slack) {
  const a = child.getBoundingClientRect();
  const b = parent.getBoundingClientRect();
  if (a.width < 0.5 || a.height < 0.5) return [];
  const bits = [];
  if (a.left < b.left - slack) bits.push("left");
  if (a.right > b.right + slack) bits.push("right");
  if (a.top < b.top - slack) bits.push("top");
  if (a.bottom > b.bottom + slack) bits.push("bottom");
  return bits;
}
function laidLines(el) {
  const node = [...el.childNodes].find((item) => item.nodeType === 3);
  if (!node) return [];
  const text = node.textContent || "";
  const host = el.getBoundingClientRect();
  const range = document.createRange();
  const lines = [];
  let line = null;
  for (let index = 0; index < text.length; index += 1) {
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!line || Math.abs(rect.top - line.top) > 2) {
      line = { top: rect.top, bottom: rect.bottom, height: rect.height, text: text[index], end: index + 1 };
      lines.push(line);
    } else {
      line.text += text[index];
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.height = Math.max(line.height, rect.height);
      line.end = index + 1;
    }
  }
  for (const row of lines) {
    const overlap = Math.min(row.bottom, host.bottom) - Math.max(row.top, host.top);
    row.overlap = overlap;
    row.visible = overlap >= row.height * 0.8;
    row.partial = overlap > 2 && overlap < row.height * 0.8;
  }
  return lines;
}
function visibleLines(el) {
  return laidLines(el).filter((line) => line.visible);
}
function partialCount(el) {
  return laidLines(el).filter((line) => line.partial).length;
}
function midWord(text, lines) {
  for (const line of lines) {
    const next = text[line.end];
    const endChar = line.text.at(-1) || "";
    if (!next || /\\s/.test(next) || /\\s/.test(endChar)) continue;
    if (endChar === "-" || endChar === "\\u00ad") continue;
    const head = text.slice(0, line.end).split(/\\s/).pop() || "";
    const rest = text.slice(line.end).split(/\\s/)[0] || "";
    if ((head + rest).length >= 20) continue;
    return line.text + "…";
  }
  return "";
}
</script>
</body>
</html>`;
  await writeFile(file, html);
  return file;
}

interface LayoutReport {
  total: number;
  revealed: boolean;
  shown: number;
  wrap: string;
  wordBreak: string;
  hyphens: string;
  fonts: { kbd: number; beat: number; status: number; votes: number };
  spacedLines: number[];
  partials: number;
  failures: string[];
  clamp: string;
}

async function launchChrome(): Promise<{
  open: (file: string) => Promise<void>;
  measure: (width: number, height: number) => Promise<LayoutReport>;
  evalAt: <T>(width: number, height: number, expression: string) => Promise<T>;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "council-chrome-"));
  const chrome: ChildProcess = spawn(
    "/usr/bin/google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    const port = await readPort(join(dir, "DevToolsActivePort"));
    const ws = await connect(port);
    return session(chrome, dir, ws);
  } catch (error) {
    chrome.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function readPort(file: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const port = Number((await readFile(file, "utf8")).split("\n")[0]?.trim());
      if (port > 0) return port;
    } catch {
      /* Chrome creates the file once the port is open. */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Chrome did not open a debugging port");
}

function session(chrome: ChildProcess, dir: string, ws: WebSocket) {
  let seq = 0;
  let sessionId = "";
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
    else waiter?.resolve(message.result);
  });
  function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++seq;
    return new Promise((resolveSend, rejectSend) => {
      pending.set(id, { resolve: (value) => resolveSend(value as Record<string, unknown>), reject: rejectSend });
      ws.send(JSON.stringify({ id, method, params, sessionId: sessionId || undefined }));
    });
  }
  return {
    async open(file: string) {
      const created = await send("Target.createTarget", { url: "about:blank" });
      const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
      sessionId = String(attached.sessionId);
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `file://${file}` });
      await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
    },
    async measure(width: number, height: number) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      const evaluated = await send("Runtime.evaluate", {
        expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { try { resolve(window.measure()); } catch (error) { resolve({ failures: [String(error && error.stack || error)], total: 0, revealed: false, shown: 0, wrap: '', wordBreak: '', hyphens: '', fonts: { kbd: 0, beat: 0, status: 0, votes: 0 }, spacedLines: [], partials: 0, clamp: '' }); } })))",
        awaitPromise: true,
        returnByValue: true,
      });
      const remote = evaluated.result as { value?: LayoutReport };
      if (!remote?.value) throw new Error(`layout measure failed at ${width}x${height}`);
      return remote.value;
    },
    async evalAt<T>(width: number, height: number, expression: string): Promise<T> {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      const evaluated = await send("Runtime.evaluate", {
        expression: `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { try { resolve(${expression}); } catch (error) { resolve({ hitCount: -1, hits: [String(error && error.stack || error)], shown: 0, extra: 0, cardHeight: 0, gridWidth: 0, gridHeight: 0, perColumn: 0 }); } })))`,
        awaitPromise: true,
        returnByValue: true,
      });
      const remote = evaluated.result as { value?: T };
      if (!remote?.value) throw new Error(`layout eval failed at ${width}x${height}`);
      return remote.value;
    },
    async close() {
      chrome.kill("SIGKILL");
      ws.close();
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function connect(port: number): Promise<WebSocket> {
  let version: { webSocketDebuggerUrl?: string } | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json())) as { webSocketDebuggerUrl?: string };
      if (version.webSocketDebuggerUrl) break;
    } catch {
      version = null;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!version?.webSocketDebuggerUrl) throw new Error("Chrome did not open a debugging port");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", () => resolveOpen());
    ws.addEventListener("error", () => rejectOpen(new Error("Chrome debugging socket failed")));
  });
  return ws;
}
