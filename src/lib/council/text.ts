/** Plain-text limits and normalization for a council board. */

export const HIRING_MAX = 60;
export const HARVEST_MAX = 80;
export const FIELD_MAX = 40;
export const NAME_MAX = 40;
export const LABEL_MAX = 32;
export const BODY_MAX = 4096;
export const STICKY_CAP = 10;
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 60_000;
export const PRESENCE_MS = 20_000;
/** Shared venue Wi-Fi is one IP. The room's network caps are this many times the per-person caps. */
export const NETWORK_LIMIT_MULTIPLIER = 20;

/** Per-IP sticky cap. COUNCIL_NETWORK_STICKY_CAP overrides the 20× default. */
export function networkStickyCap(raw: string | null | undefined): number {
  return positiveLimit(raw, STICKY_CAP * NETWORK_LIMIT_MULTIPLIER);
}

/** Per-IP writes per minute. COUNCIL_NETWORK_RATE_LIMIT overrides the 20× default. */
export function networkRateLimit(raw: string | null | undefined): number {
  return positiveLimit(raw, RATE_LIMIT * NETWORK_LIMIT_MULTIPLIER);
}

function positiveLimit(raw: string | null | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/** Keep the next poll about a second after the previous one started. A slow response still waits at least 250ms. */
export function pollDelayMs(elapsedMs: number): number {
  return Math.max(250, 1000 - elapsedMs);
}

/**
 * Store failures back off 1s, 2s, 4s, 8s, then 15s.
 * Jitter is up to a fifth of that delay, and at most 1s. The 15s step jitters
 * downward, so a poll never waits longer than 15s. A later success starts over at 1s.
 * Pass a zero jitter in tests for the exact bases.
 */
export function reconnectDelayMs(failures: number, jitter: () => number = () => Math.random()): number {
  const step = Math.max(1, Math.floor(failures));
  const base = step >= 5 ? 15_000 : 1_000 * 2 ** (step - 1);
  const unit = Math.min(1, Math.max(0, jitter()));
  const spread = Math.round(unit * Math.min(1_000, base * 0.2));
  return base >= 15_000 ? base - spread : Math.min(15_000, base + spread);
}

export interface BeatMeta {
  beat: number;
  voteOpen: boolean;
  revealed: boolean;
  arrowsOn: boolean;
}

export function sameBeat(a: BeatMeta, b: BeatMeta): boolean {
  return a.beat === b.beat && a.voteOpen === b.voteOpen && a.revealed === b.revealed && a.arrowsOn === b.arrowsOn;
}

export function nextBeatMeta(current: BeatMeta, patch: Partial<BeatMeta>): BeatMeta {
  return {
    beat: patch.beat ?? current.beat,
    voteOpen: patch.voteOpen ?? current.voteOpen,
    revealed: patch.revealed ?? current.revealed,
    arrowsOn: patch.arrowsOn ?? current.arrowsOn,
  };
}

/**
 * A beat the presenter already showed wins over a stale poll.
 * It stays until the server copy matches the pending change, or the write
 * that already succeeded.
 */
export function resolveBeat(
  server: BeatMeta,
  pending: BeatMeta | null,
  acked: BeatMeta | null,
): { meta: BeatMeta; pending: BeatMeta | null; acked: BeatMeta | null } {
  if (pending) {
    if (sameBeat(server, pending)) return { meta: server, pending: null, acked: null };
    return { meta: pending, pending, acked };
  }
  if (acked && !sameBeat(server, acked)) return { meta: acked, pending: null, acked };
  return { meta: server, pending: null, acked: null };
}
export const JOIN_PATH = "/council/join";

const SESSION_ID = /^[a-z0-9-]{1,40}$/;
const ACTOR_ID = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * The presenter URL may carry ?admin=. Next copies that query into the RSC
 * payload, so the document render redirects to the same path without it.
 * The key rides in the URL hash, which the browser does not send back.
 */
export function presenterAdminHandoff(url: URL): { clean: URL; key: string } | null {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (path !== "/council") return null;
  const key = url.searchParams.get("admin") ?? url.searchParams.get("k");
  if (!key) return null;
  const clean = new URL(url.href);
  clean.pathname = "/council";
  clean.searchParams.delete("admin");
  clean.searchParams.delete("k");
  clean.hash = "";
  return { clean, key };
}

/** `?session=` wins. `?s=` is the alias. Missing both is not a session. */
export function readSessionParam(url: URL): string | null {
  const raw = url.searchParams.has("session") ? url.searchParams.get("session") : url.searchParams.get("s");
  if (raw === null) return null;
  return parseSessionId(raw);
}

export function parseSessionId(raw: string | null): string | null {
  if (raw === null) return null;
  const id = raw.trim();
  return SESSION_ID.test(id) ? id : null;
}

/** Visible QR caption. The session stays in the QR payload, not in this label. */
export function shortJoinLabel(origin: string): string {
  try {
    return `${new URL(origin).host}${JOIN_PATH}`;
  } catch {
    return `localhost:3000${JOIN_PATH}`;
  }
}

export function joinTarget(origin: string, sessionId: string): string {
  const url = new URL(JOIN_PATH, origin);
  url.searchParams.set("session", sessionId);
  return url.toString();
}

export function parseActorId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return ACTOR_ID.test(id) ? id : null;
}

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** One decode, so stored text is the words a person typed and React can escape once. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;|&#(?:0*34|x0*22);/gi, '"')
    .replace(/&apos;|&#(?:0*39|x0*27);/gi, "'")
    .replace(/&lt;|&#(?:0*60|x0*3c);/gi, "<")
    .replace(/&gt;|&#(?:0*62|x0*3e);/gi, ">")
    .replace(/&amp;|&#(?:0*38|x0*26);/gi, "&");
}

/** Drop tags and angle brackets. Length is counted in Unicode code points. Internal spaces stay. */
export function plainText(input: unknown, max: number): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "text is required" };
  const stripped = decodeEntities(input)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(ZERO_WIDTH, "");
  const text = stripped.trim();
  if (!text.replace(/[\s\u200B-\u200D\uFEFF]/g, "")) return { ok: false, error: "text is empty" };
  if ([...text].length > max) return { ok: false, error: "text is too long" };
  return { ok: true, text };
}

export function plainName(input: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (input === undefined || input === null || input === "") return { ok: true, text: "" };
  const parsed = plainText(input, NAME_MAX);
  if (!parsed.ok) return parsed;
  return { ok: true, text: parsed.text };
}

export function isAnonymousName(name: string): boolean {
  return name.trim() === "" || name.trim().toLowerCase() === "anonymous";
}

/** Exact-duplicate key: lowercase, strip punctuation and the words a/the. */
export function normalizeCluster(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|the)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

export function csvCell(value: string): string {
  let cell = value.replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(cell)) cell = `'${cell}`;
  if (/[",]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}
