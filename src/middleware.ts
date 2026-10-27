import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { presenterAdminHandoff } from "./lib/council/text.ts";
import { applySecurityHeaders } from "./lib/security-headers.ts";

export function middleware(req: NextRequest) {
  const handoff = presenterAdminHandoff(req.nextUrl);
  if (handoff) {
    const destination = new URL(handoff.clean.href);
    destination.hash = `admin=${encodeURIComponent(handoff.key)}`;
    const response = NextResponse.redirect(destination, 307);
    response.headers.set("cache-control", "private, no-store");
    applySecurityHeaders(response.headers);
    return response;
  }
  const response = NextResponse.next();
  applySecurityHeaders(response.headers);
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
