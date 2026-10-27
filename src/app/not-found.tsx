import Link from "next/link";

export default function NotFound() {
  return (
    <main className="sheet">
      <h1>That session is not here.</h1>
      <p>Check the link, or create a new session.</p>
      <p>
        <Link className="btn" href="/create">Create a session</Link>
      </p>
    </main>
  );
}
