"use client";

import { useEffect, useRef, useState } from "react";
import { dueItems, enqueueItem, markRetry, retryDelayMs, writeOutcome, type QueueItem } from "../../lib/council/queue.ts";
import { pollDelayMs, reconnectDelayMs } from "../../lib/council/text.ts";
import type { BoardCopy } from "../../lib/council/template.ts";

interface Row {
  id: string;
  column: string;
  text: string;
  author: string;
  votes: number;
  today: { x: number; y: number } | null;
  year: { x: number; y: number } | null;
  mine: boolean;
  showName: boolean;
  late: boolean;
}

interface Board {
  stickies: Row[];
  meta: { beat: number; voteOpen: boolean; revealed: boolean };
  myVotes: { skills: string[]; channel: string | null };
}

const COLUMNS = [
  { id: "pm", label: "PM skills", tone: "butter", color: "var(--s-butter)" },
  { id: "channel", label: "Where to hunt", tone: "mint", color: "var(--s-mint)" },
] as const;

export function JoinBoard({ sessionId, content }: { sessionId: string; content?: BoardCopy }) {
  const [participantId, setParticipantId] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [ready, setReady] = useState(false);
  const [beat, setBeat] = useState(1);
  const [tab, setTab] = useState<"frame" | "hiring" | "plot" | "harvest">("frame");
  const [voteOpen, setVoteOpen] = useState(false);
  const [column, setColumn] = useState<(typeof COLUMNS)[number]["id"]>("pm");
  const [hiringText, setHiringText] = useState("");
  const [harvestText, setHarvestText] = useState("");
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [cadence, setCadence] = useState("");
  const [tools, setTools] = useState("");
  const [ai, setAi] = useState("");
  const [showChannelName, setShowChannelName] = useState(false);
  const [board, setBoard] = useState<Board | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [today, setToday] = useState<{ x: number; y: number } | null>(null);
  const [year, setYear] = useState<{ x: number; y: number } | null>(null);
  const [step, setStep] = useState<"today" | "year">("today");
  const [sliders, setSliders] = useState(false);
  const [drag, setDrag] = useState<"today" | "year" | null>(null);
  const skipClick = useRef(false);
  const [offline, setOffline] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [queued, setQueued] = useState(0);
  const [posting, setPosting] = useState(false);
  const [pending, setPending] = useState<Row[]>([]);
  const [forSomeone, setForSomeone] = useState("");

  const idKey = `council-vote-id:${sessionId}`;
  const nameKey = `council-vote-name:${sessionId}`;
  const namedKey = `council-vote-named:${sessionId}`;
  const queueKey = `council-vote-queue:${sessionId}`;
  const etag = useRef("");
  const voteChain = useRef(Promise.resolve());

  useEffect(() => {
    const id = localStorage.getItem(idKey) || crypto.randomUUID();
    localStorage.setItem(idKey, id);
    setParticipantId(id);
    setName(localStorage.getItem(nameKey) ?? "");
    setNamed(localStorage.getItem(namedKey) === "yes");
    setOffline(typeof navigator !== "undefined" ? !navigator.onLine : false);
    setReady(true);
  }, [idKey, nameKey, namedKey]);

  useEffect(() => {
    if (!participantId) return;
    let stop = false;
    let running = false;
    const failures = { current: 0 };
    function noteStoreFailure() {
      failures.current += 1;
      if (typeof navigator !== "undefined" && !navigator.onLine) setOffline(true);
      else setReconnecting(true);
    }
    async function tick() {
      if (running) return 0;
      running = true;
      const started = Date.now();
      try {
        const headers: Record<string, string> = {};
        if (etag.current) {
          headers["if-none-match"] = etag.current;
          headers["x-council-digest"] = etag.current.replace(/^W\//i, "");
        }
        const response = await fetch(`/api/council/state?session=${encodeURIComponent(sessionId)}&p=${encodeURIComponent(participantId)}`, { cache: "no-store", headers });
        if (stop) return Date.now() - started;
        if (response.status === 304) {
          failures.current = 0;
          setReconnecting(false);
          setOffline(false);
          return Date.now() - started;
        }
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) noteStoreFailure();
          return Date.now() - started;
        }
        const nextTag = response.headers.get("x-council-digest") || response.headers.get("etag");
        if (nextTag) etag.current = nextTag;
        const data = (await response.json()) as Board;
        if (stop) return Date.now() - started;
        setBoard(data);
        failures.current = 0;
        setReconnecting(false);
        setOffline(false);
        if (data.meta?.beat) setBeat(data.meta.beat);
        setVoteOpen(Boolean(data.meta?.voteOpen));
        setPending((current) => current.filter((row) => !data.stickies.some((sticky) => sticky.id === row.id)));
      } catch {
        if (!stop) noteStoreFailure();
      } finally {
        running = false;
      }
      return Date.now() - started;
    }
    async function loop() {
      while (!stop) {
        const elapsed = await tick();
        if (stop) return;
        const delay = failures.current > 0 ? reconnectDelayMs(failures.current) : pollDelayMs(elapsed);
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    }
    void loop();
    function onVisible() {
      if (document.visibilityState === "visible") void tick();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [participantId, sessionId]);

  useEffect(() => {
    setTab(beat <= 1 ? "frame" : beat === 2 ? "hiring" : beat === 3 ? "plot" : "harvest");
    setMessage("");
    setError("");
  }, [beat]);

  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => {
      setMessage("");
      setError("");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [message, error]);

  useEffect(() => {
    function online() {
      setOffline(false);
    }
    function dropped() {
      setOffline(true);
    }
    window.addEventListener("online", online);
    window.addEventListener("offline", dropped);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", dropped);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let stop = false;
    async function flush() {
      let queue = loadQueue(queueKey);
      const due = dueItems(queue, Date.now());
      if (due.length === 0) return;
      for (const item of due) {
        if (stop) return;
        let outcome: "ok" | "retry" | "drop" = "retry";
        try {
          const response = await fetch(item.url, {
            method: item.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(item.body),
          });
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          outcome = writeOutcome(response.status);
          if (response.ok && item.kind === "sticky") {
            const sticky = body as { sticky?: { late?: boolean } };
            if (sticky.sticky?.late) setMessage("The room has moved on, but your sticky made it to the wall.");
          }
          if (!response.ok && body.error === "voting closed") setError("Voting closed.");
        } catch {
          outcome = "retry";
          if (typeof navigator !== "undefined" && !navigator.onLine) setOffline(true);
          else setReconnecting(true);
        }
        queue = outcome === "retry" ? queue.map((existing) => (existing.id === item.id && existing.kind === item.kind ? markRetry(existing, Date.now()) : existing)) : queue.filter((existing) => !(existing.id === item.id && existing.kind === item.kind));
      }
      if (!stop) {
        saveQueue(queueKey, queue);
        setQueued(queue.length);
      }
    }
    void flush();
    const timer = setInterval(() => void flush(), 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [ready, queueKey]);

  function saveName(next: string, anonymous: boolean) {
    const value = anonymous ? "" : next.trim();
    localStorage.setItem(nameKey, value);
    localStorage.setItem(namedKey, "yes");
    setName(value);
    setNamed(true);
  }

  function queueWrite(item: QueueItem) {
    const next = enqueueItem(loadQueue(queueKey), { ...item, attempts: 0, nextAt: Date.now() + retryDelayMs(0) });
    saveQueue(queueKey, next);
    setQueued(next.length);
  }

  async function send(item: QueueItem): Promise<boolean> {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      queueWrite(item);
      setOffline(true);
      setMessage("You're offline. We'll post this when you're back.");
      return true;
    }
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.body),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; sticky?: { late?: boolean } };
      if (body.error === "voting closed") {
        setError("Voting closed.");
        return false;
      }
      const outcome = writeOutcome(response.status);
      if (outcome === "retry") {
        queueWrite(item);
        setMessage("saving…");
        return true;
      }
      if (outcome === "drop") {
        setError(body.error === "vote limit" ? "Out of dots in that group. Undo one first." : friendly(body.error ?? "Could not post"));
        return false;
      }
      if (body.sticky?.late) setMessage("The room has moved on, but your sticky made it to the wall.");
      else if (item.kind === "sticky") setMessage("Posted. It is on the big screen now.");
      return true;
    } catch {
      queueWrite(item);
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setOffline(true);
        setMessage("You're offline. We'll post this when you're back.");
      } else {
        setReconnecting(true);
        setMessage("saving…");
      }
      return true;
    }
  }

  async function post(columnId: string, bodyText: string, extra: Record<string, unknown> = {}) {
    setError("");
    const clientId = crypto.randomUUID();
    const author = forSomeone.trim() || name;
    const payload = { participantId, clientId, column: columnId, text: bodyText, name: author, ...extra };
    if (columnId === "pm" || columnId === "channel" || columnId === "harvest") {
      setPending((current) => [
        ...current,
        { id: clientId, column: columnId, text: bodyText, author, votes: 0, today: null, year: null, mine: true, showName: columnId === "harvest", late: false },
      ]);
    }
    setPosting(true);
    const slow = window.setTimeout(() => setMessage("saving…"), 8000);
    const ok = await send({
      id: clientId,
      kind: "sticky",
      url: `/api/council/stickies?session=${encodeURIComponent(sessionId)}`,
      method: "POST",
      body: payload,
      attempts: 0,
      nextAt: Date.now(),
    });
    window.clearTimeout(slow);
    setPosting(false);
    if (ok) {
      if (columnId === "harvest") setHarvestText("");
      else if (columnId !== "testing") setHiringText("");
      setForSomeone("");
    }
    return ok;
  }

  function sendVote(item: QueueItem): Promise<boolean> {
    const run = voteChain.current.then(() => send(item), () => send(item));
    voteChain.current = run.then(() => undefined, () => undefined);
    return run;
  }

  async function vote(stickyId: string) {
    setError("");
    const clientId = crypto.randomUUID();
    await sendVote({
      id: clientId,
      kind: "dot",
      url: `/api/council/votes?session=${encodeURIComponent(sessionId)}`,
      method: "POST",
      body: { participantId, stickyId, clientId },
      attempts: 0,
      nextAt: Date.now(),
    });
  }

  async function undo() {
    const clientId = crypto.randomUUID();
    await sendVote({
      id: clientId,
      kind: "undo",
      url: `/api/council/votes?session=${encodeURIComponent(sessionId)}`,
      method: "DELETE",
      body: { participantId, clientId },
      attempts: 0,
      nextAt: Date.now(),
    });
  }

  function chooseTab(next: "frame" | "hiring" | "plot" | "harvest") {
    setTab(next);
    setMessage("");
    setError("");
  }

  function moveMarker(dx: number, dy: number) {
    if (step === "today") {
      const base = today ?? { x: 0.5, y: 0.5 };
      setToday({ x: clamp(base.x + dx), y: clamp(base.y + dy) });
    } else {
      const base = year ?? today ?? { x: 0.5, y: 0.5 };
      setYear({ x: clamp(base.x + dx), y: clamp(base.y + dy) });
    }
  }

  function placeMarker() {
    if (step === "today") {
      setToday((current) => current ?? { x: 0.5, y: 0.5 });
      setStep("year");
    } else {
      setYear((current) => current ?? today ?? { x: 0.5, y: 0.5 });
    }
  }

  function pointFrom(event: { clientX: number; clientY: number }, target: HTMLElement) {
    const svg = target.querySelector("svg");
    const matrix = svg?.getScreenCTM()?.inverse();
    if (svg && matrix) {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      try {
        const local = point.matrixTransform(matrix);
        return {
          x: clamp((local.x - 4) / 92),
          y: clamp(1 - (local.y - 4) / 92),
        };
      } catch {
        /* fall through to the box */
      }
    }
    const rect = target.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp(1 - (event.clientY - rect.top) / Math.max(1, rect.height)),
    };
  }

  if (!ready) return <main className="phone" />;
  if (!named) {
    return (
      <main className="phone">
        <p className="ph-beat">Live · {content?.shortName || "Council"}</p>
        <h1 className="ph-title">What should we call you?</h1>
        <p className="ph-prompt">Hiring and testing stickies stay anonymous. Your name shows on a harvest offer.</p>
        <label className="ph-prompt" htmlFor="council-name">Name</label>
        <input id="council-name" className="field" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="name" />
        <button className="btn" type="button" onClick={() => saveName(name, false)}>Use this name</button>
        <button className="btn alt" type="button" onClick={() => saveName("", true)}>Skip, stay anonymous</button>
      </main>
    );
  }

  const skillsLeft = 2 - (board?.myVotes.skills.length ?? 0);
  const huntLeft = board?.myVotes.channel ? 0 : 1;
  const columns = COLUMNS.map((item) => ({ ...item, label: content?.columns[item.id] ?? item.label }));
  const active = columns.find((item) => item.id === column) ?? columns[0];
  const wall = [...(board?.stickies ?? []), ...pending.filter((row) => !(board?.stickies ?? []).some((sticky) => sticky.id === row.id))];

  return (
    <main className="phone">
      <div className="ph-top">
        <span>
          <span className="pulse" style={{ display: "inline-block", width: 10, height: 10, marginRight: 8 }} />
          Live · {content?.shortName || "Council"}
        </span>
        <button className="ph-name" type="button" onClick={() => setNamed(false)} aria-label="Your name, tap to edit">
          {name || "Anonymous"}
        </button>
      </div>
      {offline || reconnecting || queued > 0 ? (
        <p className="offline" role="status">
          {offline
            ? `You're offline. We'll post this when you're back.${queued > 0 ? ` ${queued} waiting.` : ""}`
            : queued > 0
              ? "saving…"
              : "reconnecting…"}
        </p>
      ) : null}
      {error ? <p className="err" role="alert">{error}</p> : null}
      {message ? <p className="toast" role="status">{message}</p> : null}
      <div className="tabs" role="tablist" aria-label="Section">
        <button type="button" aria-pressed={tab === "hiring"} onClick={() => chooseTab("hiring")}>Hiring</button>
        <button type="button" aria-pressed={tab === "plot"} onClick={() => chooseTab("plot")}>2x2</button>
        <button type="button" aria-pressed={tab === "harvest"} onClick={() => chooseTab("harvest")}>Harvest</button>
      </div>

      {tab === "frame" ? (
        <>
          <p className="ph-beat">Framing</p>
          <h1 className="ph-title">You&apos;re in.</h1>
          <p className="ph-prompt">{content?.waiting || "The room is framing. Your first prompt is coming. This phone will follow the big screen."}</p>
        </>
      ) : null}

      {tab === "hiring" && !voteOpen ? (
        <>
          <p className="ph-beat">Hiring wall</p>
          <h1 className="ph-title">Hire for what? Hunt where?</h1>
          <div className="seg" role="group" aria-label="Which column">
            {columns.map((item) => (
              <button key={item.id} type="button" aria-pressed={column === item.id} style={{ background: item.color }} onClick={() => setColumn(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <div className={`compose ${active.tone}`} style={{ background: active.color }}>
            <textarea aria-label="Your sticky" maxLength={60} value={hiringText} onChange={(event) => setHiringText(event.target.value.slice(0, 60))} placeholder="One idea, big letters" />
            <span className="count">{hiringText.length} / 60</span>
          </div>
          {column === "channel" ? (
            <label className="ph-prompt" style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
              <input type="checkbox" checked={showChannelName} onChange={(event) => setShowChannelName(event.target.checked)} />
              Show my name on this channel
            </label>
          ) : null}
          <label className="ph-prompt" htmlFor="for-someone">Posting for someone else</label>
          <input id="for-someone" className="field" value={forSomeone} onChange={(event) => setForSomeone(event.target.value.slice(0, 40))} placeholder="Leave blank to use your name" />
          <button className="btn" type="button" disabled={!hiringText.trim() || posting} onClick={() => void post(column, hiringText, column === "channel" ? { showName: showChannelName } : {})}>
            {posting ? "Posting..." : `Post to ${active.label}`}
          </button>
          <p className="mine">Yours on the wall</p>
          <div className="vlist">
            {wall.filter((row) => row.mine && (row.column === "pm" || row.column === "channel")).map((row) => (
              <article key={row.id} className={`sticky ${tone(row.column)} ${pending.some((item) => item.id === row.id) ? "pending" : ""}`}>
                <span className="txt">{row.text}</span>
              </article>
            ))}
          </div>
        </>
      ) : null}

      {tab === "hiring" && voteOpen ? (
        <>
          <p className="ph-beat">Vote open</p>
          <h1 className="ph-title">Place your three dots</h1>
          <p className="ph-prompt">2 on skills. 1 on where to hunt. Both skill dots may land on one sticky.</p>
          {columns.map((item) => (
            <section key={item.id}>
              <h2 className="ph-sec">{item.label}</h2>
              <div className="vlist">
                {wall.filter((row) => row.column === item.id).map((row) => {
                  const mineCount = item.id === "channel"
                    ? (board?.myVotes.channel === row.id ? 1 : 0)
                    : (board?.myVotes.skills ?? []).filter((id) => id === row.id).length;
                  return (
                    <button
                      key={row.id}
                      className={`sticky ${item.tone}`}
                      type="button"
                      style={{ width: "100%", textAlign: "left" }}
                      aria-label={`${row.text}. ${mineCount > 0 ? "Your dot is on this one." : "No dot from you yet."} Tap to add a dot.`}
                      onClick={() => void vote(row.id)}
                    >
                      <span className="txt">{row.text}</span>
                      <span className="dots">{Array.from({ length: mineCount }, (_, index) => <span className="dot" key={index} />)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          <div className="tray" role="status">
            <span>Skills</span>
            <span className={skillsLeft < 2 ? "dot" : "dot ghost"} />
            <span className={skillsLeft < 1 ? "dot" : "dot ghost"} />
            <span>Hunt</span>
            <span className={huntLeft < 1 ? "dot" : "dot ghost"} />
            <button className="btn alt" type="button" style={{ width: "auto", margin: 0, minHeight: 44 }} onClick={() => void undo()}>Undo</button>
          </div>
        </>
      ) : null}

      {tab === "plot" ? (
        <>
          <p className="ph-beat">Testing 2x2</p>
          <h1 className="ph-title">Where do you test?</h1>
          <p className="ph-prompt">{step === "today" ? "Tap where your team tests today." : "Tap where you want to be in a year."}</p>
          <div
            className="plot"
            tabIndex={0}
            role="application"
            aria-label="Testing grid. Arrow keys move the marker. Enter places it. Top is A/B tests. Bottom is talking to users. Left is one owner. Right is every PM."
            style={{ width: "100%", aspectRatio: "1", marginTop: 16, touchAction: "none" }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") return;
              event.preventDefault();
              if (event.key === "Enter") {
                placeMarker();
                return;
              }
              const stepSize = 0.05;
              const dx = event.key === "ArrowLeft" ? -stepSize : event.key === "ArrowRight" ? stepSize : 0;
              const dy = event.key === "ArrowUp" ? stepSize : event.key === "ArrowDown" ? -stepSize : 0;
              moveMarker(dx, dy);
            }}
            onClick={(event) => {
              if (skipClick.current) {
                skipClick.current = false;
                return;
              }
              const point = pointFrom(event, event.currentTarget);
              if (step === "today") {
                setToday(point);
                setStep("year");
              } else setYear(point);
            }}
          >
            <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="phone-arrow" markerUnits="userSpaceOnUse" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto">
                  <path d="M0 0 L10 5 L0 10 Z" fill="#2B2118" />
                </marker>
              </defs>
              <rect x="2" y="2" width="96" height="96" fill="#FBF4E6" stroke="#2B2118" strokeWidth="1.4" />
              <path d="M50 2 V98 M2 50 H98" stroke="#2B2118" strokeWidth="0.8" />
              {today && year ? (
                <line x1={4 + today.x * 92} y1={4 + (1 - today.y) * 92} x2={4 + year.x * 92} y2={4 + (1 - year.y) * 92} stroke="#2B2118" strokeOpacity="0.55" strokeWidth="0.8" markerEnd="url(#phone-arrow)" />
              ) : null}
              {today ? (
                <circle
                  cx={4 + today.x * 92}
                  cy={4 + (1 - today.y) * 92}
                  className="pin"
                  r="4.8"
                  fill="#1F6F78"
                  stroke="#2B2118"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    skipClick.current = true;
                    setDrag("today");
                  }}
                  onPointerMove={(event) => {
                    if (drag !== "today") return;
                    const plot = event.currentTarget.ownerSVGElement?.parentElement;
                    if (plot) setToday(pointFrom(event, plot));
                  }}
                  onPointerUp={() => setDrag(null)}
                />
              ) : null}
              {year ? (
                <circle
                  cx={4 + year.x * 92}
                  cy={4 + (1 - year.y) * 92}
                  className="pin"
                  r="4.8"
                  fill="#E4572E"
                  stroke="#2B2118"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    skipClick.current = true;
                    setDrag("year");
                  }}
                  onPointerMove={(event) => {
                    if (drag !== "year") return;
                    const plot = event.currentTarget.ownerSVGElement?.parentElement;
                    if (plot) setYear(pointFrom(event, plot));
                  }}
                  onPointerUp={() => setDrag(null)}
                />
              ) : null}
            </svg>
            <div className="hand axis-top">A/B tests</div>
            <div className="hand axis-bottom">Talking to users</div>
            <div className="hand axis-left">← One owner</div>
            <div className="hand axis-right">Every PM →</div>
          </div>
          <button className="btn alt" type="button" onClick={() => setSliders((value) => !value)}>Place with buttons</button>
          {sliders ? (
            <div className="sliders">
              <label>Ownership today<input aria-label="Ownership today" type="range" min={0.125} max={0.875} step={0.25} value={today?.x ?? 0.625} onChange={(event) => setToday({ x: Number(event.target.value), y: today?.y ?? 0.625 })} /></label>
              <label>Rigor today<input aria-label="Rigor today" type="range" min={0.125} max={0.875} step={0.25} value={today?.y ?? 0.625} onChange={(event) => setToday({ x: today?.x ?? 0.625, y: Number(event.target.value) })} /></label>
              <label>Ownership in a year<input aria-label="Ownership in a year" type="range" min={0.125} max={0.875} step={0.25} value={year?.x ?? 0.625} onChange={(event) => setYear({ x: Number(event.target.value), y: year?.y ?? 0.625 })} /></label>
              <label>Rigor in a year<input aria-label="Rigor in a year" type="range" min={0.125} max={0.875} step={0.25} value={year?.y ?? 0.625} onChange={(event) => setYear({ x: year?.x ?? 0.625, y: Number(event.target.value) })} /></label>
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn alt" type="button" onClick={() => { if (year) setYear(null); else { setToday(null); setStep("today"); } }}>Undo</button>
            <button
              className="btn"
              type="button"
              disabled={!today || !year || posting}
              onClick={() => void post("testing", label.trim() || "Where we test today", { today, year, owner, cadence, tools, ai })}
            >
              {posting ? "Posting..." : "Lock it in"}
            </button>
          </div>
          {([
            ["test-owner", "Owner", owner, setOwner],
            ["test-cadence", "Cadence", cadence, setCadence],
            ["test-tools", "Tools", tools, setTools],
            ["test-ai", "What AI does", ai, setAi],
          ] as const).map(([id, title, value, setValue]) => (
            <label key={id} className="ph-prompt" htmlFor={id}>
              {title}
              <input id={id} className="field" value={value} maxLength={40} onChange={(event) => setValue(event.target.value.slice(0, 40))} />
            </label>
          ))}
          <label className="ph-prompt" htmlFor="test-label">Optional label</label>
          <input id="test-label" className="field" value={label} maxLength={60} onChange={(event) => setLabel(event.target.value.slice(0, 60))} />
        </>
      ) : null}

      {tab === "harvest" ? (
        <>
          <p className="ph-beat">Harvest</p>
          <h1 className="ph-title">I&apos;ll give you</h1>
          <p className="ph-prompt">Your name shows on this one.</p>
          <label className="ph-prompt" htmlFor="harvest-name">Your name on this offer</label>
          <input
            id="harvest-name"
            className="field"
            value={name}
            maxLength={40}
            placeholder="Name"
            onChange={(event) => {
              const value = event.target.value.slice(0, 40);
              setName(value);
              localStorage.setItem(nameKey, value);
            }}
          />
          {!name.trim() && !forSomeone.trim() ? <p className="warn">Add your name here, then the offer can go up.</p> : null}
          <div className="compose lilac" style={{ background: "var(--s-lilac)" }}>
            <textarea aria-label="Your offer" maxLength={80} value={harvestText} onChange={(event) => setHarvestText(event.target.value.slice(0, 80))} />
            <span className="count">{harvestText.length} / 80</span>
          </div>
          <button className="btn" type="button" disabled={!harvestText.trim() || (!name && !forSomeone.trim()) || posting} onClick={() => void post("harvest", harvestText)}>
            {posting ? "Posting..." : "Post offer"}
          </button>
          <div className="vlist">
            {wall.filter((row) => row.column === "harvest").map((row) => (
              <article key={row.id} className="sticky lilac">
                <span className="txt">{row.text}</span>
                <span className="by">{row.showName ? row.author : ""}</span>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </main>
  );
}

function loadQueue(key: string): QueueItem[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as QueueItem[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(key: string, items: QueueItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
}

function tone(column: string): string {
  if (column === "designer") return "coral";
  if (column === "channel") return "mint";
  return "butter";
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

function friendly(error: string): string {
  if (error === "text is empty" || error === "text is required") return "Write a few words before posting.";
  if (error === "too many stickies") return "This column is full. Ten is the most one person can post here.";
  if (error === "text is too long") return "That's a bit long. Shorten it and post again.";
  if (error === "name required") return "Add your name on this offer, then post.";
  return error;
}
