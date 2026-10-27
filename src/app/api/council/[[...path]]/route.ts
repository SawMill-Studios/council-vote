import { readServerEnv } from "../../../../lib/env.ts";
import { councilClientIp, handleCouncil } from "../../../../lib/council/http.ts";
import { councilStore } from "../../../../lib/council/store.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request) {
  return handleCouncil(request, {
    store: councilStore(),
    creatorKey: readServerEnv("COUNCIL_CREATOR_KEY"),
    now: Date.now(),
    ip: councilClientIp(request.headers.get("x-nf-client-connection-ip"), request.headers.get("x-forwarded-for")),
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const HEAD = handle;
