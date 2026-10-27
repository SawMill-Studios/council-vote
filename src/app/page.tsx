import Link from "next/link";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <main className="sheet">
      <p className="beat">Council vote</p>
      <h1>One room. One board. One key.</h1>
      <p>
        People join from their phones and post stickies. The presenter runs the beats on a big screen.
        Each session has its own admin key, so one council cannot open another.
      </p>
      <p>
        <Link className="btn" href="/create">Create a session</Link>
      </p>
      <p>
        The person who creates a session gets a presenter link, a join link, and an admin key.
        The admin key is shown once. Keep it. It is the only way to advance beats, reveal votes, and export the board.
      </p>
    </main>
  );
}
