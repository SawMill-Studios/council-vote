import { normalizeCluster } from "./text.ts";

export const TILTS = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2] as const;

export function tiltFor(id: string): number {
  return TILTS[hash(id) % TILTS.length];
}

/** Stable quadratic bulge for a sketchy arrow, in the range -30..30. */
export function curveOffset(id: string): number {
  const steps = [-30, -20, -10, 0, 10, 20, 30];
  return steps[hash(id) % steps.length];
}

export interface HiringTier {
  across: number;
  font: number;
  minH: number;
  clamp: number;
  stack: boolean;
  empty: boolean;
}

/** Layout tier from the number of stacks in the fullest hiring column. */
export function hiringTier(count: number): HiringTier {
  if (count <= 0) return { across: 2, font: 34, minH: 150, clamp: 4, stack: false, empty: true };
  if (count <= 6) return { across: 2, font: 34, minH: 150, clamp: 4, stack: false, empty: false };
  if (count <= 10) return { across: 2, font: 30, minH: 130, clamp: 4, stack: false, empty: false };
  if (count <= 15) return { across: 3, font: 28, minH: 110, clamp: 3, stack: false, empty: false };
  return { across: 3, font: 28, minH: 110, clamp: 3, stack: true, empty: false };
}

export interface HarvestTier {
  across: number;
  font: number;
  minH: number;
  clamp: number;
  limit: number;
}

export function harvestTier(count: number): HarvestTier {
  if (count <= 12) return { across: 4, font: 34, minH: 170, clamp: 4, limit: 12 };
  if (count <= 20) return { across: 5, font: 30, minH: 140, clamp: 4, limit: 20 };
  return { across: 6, font: 28, minH: 110, clamp: 3, limit: 18 };
}

export function columnOfBeat(beat: number): "hiring" | "testing" | "harvest" | "framing" {
  if (beat === 2) return "hiring";
  if (beat === 3) return "testing";
  if (beat === 4) return "harvest";
  return "framing";
}

export function beatOfColumn(column: string): number {
  if (column === "pm" || column === "designer" || column === "channel") return 2;
  if (column === "testing") return 3;
  return 4;
}

export type QuadrantName = "Test team" | "Every PM experiments" | "Research desk" | "Everyone talks to users";

/** x: 0 one owner → 1 every PM. y: 0 directional (bottom) → 1 statistical (top). */
export function quadrantName(x: number, y: number): QuadrantName {
  const right = x >= 0.5;
  const top = y >= 0.5;
  if (top && !right) return "Test team";
  if (top && right) return "Every PM experiments";
  if (!top && !right) return "Research desk";
  return "Everyone talks to users";
}

export interface Stackable {
  id: string;
  column: string;
  text: string;
  stackOf: string | null;
  hidden: boolean;
  createdAt: string;
  label?: string;
}

export interface StackGroup<T extends Stackable> {
  root: T;
  members: T[];
  votes: number;
}

export function stackGroups<T extends Stackable>(
  stickies: readonly T[],
  column: string,
  votesFor: (id: string) => number,
  revealed: boolean,
): StackGroup<T>[] {
  const visible = stickies.filter((sticky) => sticky.column === column && !sticky.hidden);
  const byId = new Map(visible.map((sticky) => [sticky.id, sticky]));
  const roots = visible.filter((sticky) => !sticky.stackOf || !byId.has(sticky.stackOf));
  const groups = roots.map((root) => {
    const members = [root, ...visible.filter((sticky) => sticky.stackOf === root.id)];
    const votes = members.reduce((sum, sticky) => sum + votesFor(sticky.id), 0);
    return { root, members, votes };
  });
  groups.sort((a, b) => {
    if (revealed && b.votes !== a.votes) return b.votes - a.votes;
    return a.root.createdAt < b.root.createdAt ? -1 : a.root.createdAt > b.root.createdAt ? 1 : 0;
  });
  return groups;
}

/** Merge explicit stacks, then identical normalized text that was never split. */
export function clusterGroups<T extends Stackable & { noAuto?: boolean }>(
  stickies: readonly T[],
  column: string,
  votesFor: (id: string) => number,
  revealed: boolean,
): StackGroup<T>[] {
  const groups = stackGroups(stickies, column, votesFor, revealed);
  const merged: StackGroup<T>[] = [];
  const byText = new Map<string, number>();
  for (const group of groups) {
    const key = normalizeCluster(group.root.text);
    const slot = key && !group.root.noAuto ? byText.get(key) : undefined;
    if (slot === undefined || merged[slot]?.root.noAuto) {
      if (key && !group.root.noAuto) byText.set(key, merged.length);
      merged.push({ root: group.root, members: [...group.members], votes: group.votes });
    } else {
      merged[slot].members.push(...group.members);
      merged[slot].votes += group.votes;
    }
  }
  return merged;
}

export interface StickyFit {
  across: number;
  font: number;
  pageSize: number;
}

/** Notes still off the wall after the page that starts at `start` and shows `shown`. */
export function remainingStickies(total: number, start: number, shown: number): number {
  return Math.max(0, total - start - shown);
}

/**
 * Split measured sticky heights into pages. Each row is only as tall as the
 * notes on it, and the last cell of a full page is the +N more button.
 * One tall note later in the column does not stretch every row.
 */
export function stickyPages(heights: readonly number[], boxHeight: number, buttonHeight = 52, across = 2): number[] {
  const gap = 10;
  const pages: number[] = [];
  let index = 0;
  while (index < heights.length && pages.length <= heights.length) {
    const count = stickyPageCount(heights.slice(index), boxHeight, buttonHeight, across, gap);
    const take = Math.min(heights.length - index, Math.max(1, count));
    pages.push(take);
    index += take;
  }
  return pages;
}

function stickyPageCount(heights: readonly number[], boxHeight: number, buttonHeight: number, across: number, gap: number): number {
  if (heights.length === 0) return 0;
  if (blockHeight(heights, across, gap) <= boxHeight) return heights.length;
  let fit = 1;
  for (let count = 1; count < heights.length; count += 1) {
    if (blockHeight([...heights.slice(0, count), buttonHeight], across, gap) <= boxHeight) fit = count;
    else break;
  }
  return fit;
}

function blockHeight(cells: readonly number[], across: number, gap: number): number {
  let used = 0;
  const rows = Math.ceil(cells.length / Math.max(1, across));
  for (let row = 0; row < rows; row += 1) {
    let rowHeight = 0;
    for (let column = 0; column < across; column += 1) {
      const height = cells[row * across + column];
      if (height) rowHeight = Math.max(rowHeight, height);
    }
    used += rowHeight;
    if (row > 0) used += gap;
  }
  return used;
}

/**
 * Shrink columns and type until `count` stickies fit in the box.
 * What still does not fit is a later page, reached from the +N chip.
 * `rowHeight` is a measured sticky in CSS px (the tallest rendered note).
 * Revealed ranked notes are about 250px, and unrevealed notes vary with the
 * copy, so neither can use the 140px guess without overlapping the next row.
 */
export function fitStickyLayout(count: number, width: number, height: number, rowHeight = 0): StickyFit {
  if (count <= 0 || width < 40 || height < 40) return { across: 2, font: 30, pageSize: Math.max(0, count) };
  const gap = 10;
  const measured = rowHeight >= 48 ? rowHeight : 0;
  if (!measured) {
    const candidates = [
      { across: 2, font: 30, row: 150 },
      { across: 2, font: 28, row: 140 },
    ];
    for (const candidate of candidates) {
      const colW = (width - gap * (candidate.across - 1)) / candidate.across;
      if (colW < 88) continue;
      const rows = Math.ceil(count / candidate.across);
      const needed = rows * candidate.row + Math.max(0, rows - 1) * gap;
      if (needed <= height) return { across: candidate.across, font: candidate.font, pageSize: count };
    }
  }
  const across = 2;
  const row = measured || 140;
  const rows = Math.max(1, Math.floor((height + gap) / (row + gap)));
  const slots = Math.max(1, rows * across - 1);
  const needed = Math.ceil(count / across) * row + Math.max(0, Math.ceil(count / across) - 1) * gap;
  if (measured && needed <= height) return { across, font: 28, pageSize: count };
  return { across, font: 28, pageSize: Math.min(count, slots) };
}

export function topRanks<T extends Stackable>(groups: readonly StackGroup<T>[], revealed: boolean): Map<string, number> {
  const ranks = new Map<string, number>();
  if (!revealed) return ranks;
  groups.slice(0, 3).forEach((group, index) => {
    if (group.votes > 0) ranks.set(group.root.id, index + 1);
  });
  return ranks;
}

export function autoParentId<T extends Stackable & { noAuto?: boolean }>(
  stickies: readonly T[],
  column: string,
  text: string,
): string | null {
  const norm = normalizeCluster(text);
  if (!norm) return null;
  const match = stickies.find(
    (sticky) =>
      sticky.column === column &&
      !sticky.hidden &&
      !sticky.stackOf &&
      !sticky.noAuto &&
      normalizeCluster(sticky.text) === norm,
  );
  return match?.id ?? null;
}

function hash(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 33) + id.charCodeAt(index)) >>> 0;
  }
  return value;
}
