import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JoinBoard } from "../../../components/council/join-board.tsx";
import { readSessionRecord } from "../../../lib/council/sessions.ts";
import { councilStore } from "../../../lib/council/store.ts";
import { readSessionParam } from "../../../lib/council/text.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; s?: string }>;
}): Promise<Metadata> {
  const record = await load(await searchParams);
  return { title: record ? `Join ${record.content.shortName}` : "Join" };
}

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ session?: string; s?: string }> }) {
  const record = await load(await searchParams);
  if (!record) notFound();
  return <JoinBoard sessionId={record.slug} content={record.content} />;
}

async function load(params: { session?: string; s?: string }) {
  const url = new URL("http://localhost:3000/council/join");
  if (params.session !== undefined) url.searchParams.set("session", params.session);
  else if (params.s !== undefined) url.searchParams.set("s", params.s);
  const sessionId = readSessionParam(url);
  if (!sessionId) return null;
  return readSessionRecord(councilStore(), sessionId);
}
