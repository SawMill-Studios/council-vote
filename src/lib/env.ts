/** Constant-time string compare. Length differences still walk the longer side. */
export function timingSafeEqualText(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/**
 * Netlify.env when the runtime exposes it, otherwise process.env.
 * Read at request time. A build can freeze process.env before secrets exist.
 */
export function readServerEnv(name: string): string {
  const fromNetlify = netlifyEnv(name);
  if (fromNetlify) return fromNetlify;
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

function netlifyEnv(name: string): string {
  const runtime = globalThis as {
    Netlify?: { env?: { get?: (key: string) => unknown } };
  };
  const get = runtime.Netlify?.env?.get;
  if (typeof get !== "function") return "";
  try {
    const value = get(name);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** Prefer Netlify's client IP. Otherwise the first forwarded hop, never a later proxy. */
export function normalizeClientAddress(netlifyIp: string | null, platformIp: string | null): string {
  return cleanAddress(netlifyIp) ?? cleanAddress(platformIp) ?? "unknown";
}

function cleanAddress(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 64) return null;
  if (!/^[0-9a-f:.]+$/i.test(trimmed)) return null;
  return trimmed.toLowerCase();
}
