import type { Metadata } from "next";
import { CreateSession } from "../../components/council/create-session.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create a council session" };

export default function CreatePage() {
  return (
    <main className="sheet">
      <p className="beat">New session</p>
      <h1>Create a council</h1>
      <p>
        Use the creator key from the person who set up this site. It can start a session.
        It cannot run someone else&apos;s board. The admin key you receive works only for the session you create.
      </p>
      <CreateSession />
    </main>
  );
}
