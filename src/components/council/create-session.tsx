"use client";

import { useState, type FormEvent } from "react";

interface Created {
  slug: string;
  title: string;
  adminKey: string;
  presenterUrl: string;
  joinUrl: string;
  adminUrl: string;
}

export function CreateSession() {
  const [creatorKey, setCreatorKey] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [pm, setPm] = useState("");
  const [channel, setChannel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [captureMoves, setCaptureMoves] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    const body: Record<string, unknown> = { slug: slug.trim(), title: title.trim() };
    const columns: Record<string, string> = {};
    if (pm.trim()) columns.pm = pm.trim();
    if (channel.trim()) columns.channel = channel.trim();
    if (Object.keys(columns).length > 0) body.columns = columns;
    if (prompt.trim()) body.beats = [{ n: 1, prompt: prompt.trim() }];
    if (captureMoves.trim()) body.captureMoves = captureMoves.trim();
    if (template) body.template = template;
    try {
      const response = await fetch("/api/council/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${creatorKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Created & { error?: string };
      if (!response.ok) {
        setError(payload.error || "Could not create that session.");
        return;
      }
      setCreated(payload);
      setCreatorKey("");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <section>
        <p className="warn">Copy the admin key now. This page does not keep it, and the server stores only a hash.</p>
        <label htmlFor="admin-key">Admin key for {created.title}</label>
        <input id="admin-key" readOnly value={created.adminKey} />
        <ul>
          <li>
            Presenter: <a href={created.presenterUrl}>{created.presenterUrl}</a>
          </li>
          <li>
            Join: <a href={created.joinUrl}>{created.joinUrl}</a>
          </li>
          <li>
            Open as admin once: <a href={created.adminUrl}>{created.adminUrl}</a>
          </li>
        </ul>
        <p>The admin link moves the key into the address bar hash so it is not stored in the page.</p>
      </section>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="creator-key">Creator key</label>
      <input
        id="creator-key"
        type="password"
        autoComplete="off"
        value={creatorKey}
        onChange={(event) => setCreatorKey(event.target.value)}
        required
      />
      <label htmlFor="slug">Session slug</label>
      <input
        id="slug"
        value={slug}
        onChange={(event) => setSlug(event.target.value)}
        placeholder="tommy-2026-11-04"
        pattern="[a-z0-9-]{1,40}"
        required
      />
      <p>Lowercase letters, numbers, and hyphens. This becomes part of the link.</p>
      <label htmlFor="template">Starting copy</label>
      <select id="template" value={template} onChange={(event) => setTemplate(event.target.value)}>
        <option value="">Generic</option>
        <option value="product-council">Product council</option>
      </select>
      <p>Generic works for any room. Product council is the hiring-and-testing script, including its original capture heading.</p>
      <label htmlFor="title">Title</label>
      <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Tuesday council" required />
      <label htmlFor="pm">First column name</label>
      <input id="pm" value={pm} onChange={(event) => setPm(event.target.value)} placeholder="PM skills" />
      <label htmlFor="channel">Second column name</label>
      <input id="channel" value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="Where to hunt" />
      <label htmlFor="prompt">Opening line</label>
      <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Leave blank to keep the template line." />
      <label htmlFor="moves">Capture sheet closing heading</label>
      <input
        id="moves"
        value={captureMoves}
        onChange={(event) => setCaptureMoves(event.target.value)}
        placeholder="Leave blank to keep the template heading."
      />
      {error ? <p className="err" role="alert">{error}</p> : null}
      <button className="btn" type="submit" disabled={pending}>{pending ? "Creating…" : "Create session"}</button>
    </form>
  );
}
