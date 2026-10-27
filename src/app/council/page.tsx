import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Deck } from "../../components/council/deck.tsx";
import { presentJoin, requestOrigin } from "../../lib/council/origin.ts";
import { readSessionRecord } from "../../lib/council/sessions.ts";
import { councilStore } from "../../lib/council/store.ts";
import { readSessionParam } from "../../lib/council/text.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; s?: string }>;
}): Promise<Metadata> {
  const record = await load(await searchParams);
  return { title: record?.content.title ?? "Council" };
}

export default async function CouncilPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; s?: string }>;
}) {
  const record = await load(await searchParams);
  if (!record) notFound();
  const headerStore = await headers();
  const origin = requestOrigin(headerStore.get("x-forwarded-host") ?? headerStore.get("host"), headerStore.get("x-forwarded-proto"));
  const join = presentJoin(origin, record.slug);
  const qrSvg = await QRCode.toString(join.href, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#2B2118", light: "#FFFFFF" },
  });
  return <Deck sessionId={record.slug} qrSvg={qrSvg} shortUrl={join.label} content={record.content} />;
}

async function load(params: { session?: string; s?: string }) {
  const sessionId = sessionFrom(params);
  if (!sessionId) return null;
  return readSessionRecord(councilStore(), sessionId);
}

function sessionFrom(params: { session?: string; s?: string }): string | null {
  const url = new URL("http://localhost:3000/council");
  if (params.session !== undefined) url.searchParams.set("session", params.session);
  else if (params.s !== undefined) url.searchParams.set("s", params.s);
  return readSessionParam(url);
}
