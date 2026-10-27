import { joinTarget, shortJoinLabel } from "./text.ts";

export function requestOrigin(hostHeader: string | null, protoHeader: string | null): string {
  const host = (hostHeader ?? "").split(",")[0].trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) return "http://localhost:3000";
  const forwarded = (protoHeader ?? "").split(",")[0].trim();
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

/** Prefer the forwarded host. Otherwise the request URL's own origin. */
export function publicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = request.headers.get("host");
  if (forwardedHost || host) return requestOrigin(forwardedHost ?? host, request.headers.get("x-forwarded-proto"));
  try {
    return new URL(request.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

export function presentJoin(origin: string, sessionId: string): { href: string; label: string } {
  return { href: joinTarget(origin, sessionId), label: shortJoinLabel(origin) };
}
