"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clusterGroups, curveOffset, fitStickyLayout, remainingStickies, stickyPages, topRanks } from "../../lib/council/group.ts";
import { nextBeatMeta, pollDelayMs, reconnectDelayMs, resolveBeat, sameBeat, type BeatMeta } from "../../lib/council/text.ts";
import type { BoardCopy } from "../../lib/council/template.ts";

interface Row {
  id: string;
  column: string;
  text: string;
  author: string;
  votes: number;
  today: { x: number; y: number } | null;
  year: { x: number; y: number } | null;
  showName: boolean;
  late: boolean;
  createdAt: string;
  stackOf: string | null;
  label: string;
  noAuto: boolean;
  hidden: boolean;
}

interface Meta {
  beat: number;
  voteOpen: boolean;
  revealed: boolean;
  arrowsOn: boolean;
}

interface Board {
  stickies: Row[];
  admin: boolean;
  phones?: number;
  meta: Meta;
}

const BEATS = [
  { n: 1, kicker: "Beat 1 of 4 · Framing", title: "Set the frame.", prompt: "What this room is here to decide" },
  { n: 2, kicker: "Beat 2 of 4 · Hiring wall", title: "Hire for what? Hunt where?", prompt: "2 dots on skills you would hire for tomorrow. 1 dot on the channel you would try first." },
  { n: 3, kicker: "Beat 3 of 4 · Testing 2x2", title: "How do lean teams actually test?", prompt: "Place a today dot, then a 1 year dot. Be honest, not the board deck." },
  { n: 4, kicker: "Beat 4 of 4 · Harvest", title: "I'll give you ___", prompt: "An intro, a channel, a template, or 20 minutes on the phone." },
];

const NOTES = [
  "Walk the room through the shape of the problem. Name the two questions the wall will ask.",
  "Open the vote with V. Two skill dots, and both may land on one sticky. One hunt dot. R re-ranks and numbers the top three. M merges two stickies. Shift+M splits the selected stack.",
  "R hides the arrows so the room sees today before the year ahead. The room-average arrow appears once three people have placed both dots.",
  "Names show on offers. E downloads the capture sheet, JSON, and CSV.",
];

export function Deck({
  sessionId,
  qrSvg,
  shortUrl,
  content,
}: {
  sessionId: string;
  qrSvg: string;
  shortUrl: string;
  content?: BoardCopy;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [merge, setMerge] = useState(false);
  const [pick, setPick] = useState("");
  const [selected, setSelected] = useState("");
  const [hideChrome, setHideChrome] = useState(false);
  const [help, setHelp] = useState(false);
  const [notes, setNotes] = useState(false);
  const [listColumn, setListColumn] = useState<string | null>(null);
  const [pageBump, setPageBump] = useState(0);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [fit, setFit] = useState(1);
  const [key, setKey] = useState("");
  const [adminOn, setAdminOn] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const etag = useRef("");
  const pendingBeat = useRef<BeatMeta | null>(null);
  const ackedBeat = useRef<BeatMeta | null>(null);
  const beatWrite = useRef(0);
  const writingBeat = useRef(false);
  const alive = useRef(true);
  const bag = useRef({
    beat: 1,
    merge: false,
    pick: "",
    selected: "",
    voteOpen: false,
    revealed: false,
    arrowsOn: true,
  });

  const meta = board?.meta ?? { beat: 1, voteOpen: false, revealed: false, arrowsOn: true };
  bag.current = { beat: meta.beat, merge, pick, selected, voteOpen: meta.voteOpen, revealed: meta.revealed, arrowsOn: meta.arrowsOn };

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("admin") ?? url.searchParams.get("k") ?? "";
    const fromHash = url.hash.startsWith("#admin=") ? decodeHash(url.hash.slice("#admin=".length)) : "";
    const adminStore = `council-vote-admin:${sessionId}`;
    const stored = window.sessionStorage.getItem(adminStore) ?? "";
    const next = fromUrl || fromHash || stored;
    if (next) window.sessionStorage.setItem(adminStore, next);
    if (fromHash) {
      url.hash = "";
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
    // Next's router writes the request URL, including ?admin=, back onto
    // history after hydration. Strip until that commit has landed, and pass
    // null so the patched replaceState adopts the cleaned URL as canonical.
    function strip() {
      const current = new URL(window.location.href);
      if (!current.searchParams.has("admin") && !current.searchParams.has("k")) return;
      current.searchParams.delete("admin");
      current.searchParams.delete("k");
      const query = current.searchParams.toString();
      window.history.replaceState(null, "", `${current.pathname}${query ? `?${query}` : ""}${current.hash}`);
    }
    strip();
    const timers = [0, 50, 250, 1000, 2000].map((ms) => window.setTimeout(strip, ms));
    let cancel = false;
    if (next) {
      void fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(next)}`)
        .then((response) => {
          if (cancel) return;
          if (response.ok || response.status === 429 || response.status >= 500) {
            setKey(next);
            setAdminOn(true);
            return;
          }
          window.sessionStorage.removeItem(adminStore);
          setKey("");
          setAdminOn(false);
        })
        .catch(() => {
          if (cancel) return;
          setKey(next);
          setAdminOn(true);
        });
    }
    return () => {
      cancel = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    function measure() {
      setFit(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let stop = false;
    let running = false;
    const failures = { current: 0 };
    async function tick() {
      if (running) return 0;
      running = true;
      const started = Date.now();
      try {
        const adminQuery = key ? `&admin=${encodeURIComponent(key)}` : "";
        const headers: Record<string, string> = {};
        if (etag.current) {
          headers["if-none-match"] = etag.current;
          headers["x-council-digest"] = etag.current.replace(/^W\//i, "");
        }
        const response = await fetch(`/api/council/state?session=${encodeURIComponent(sessionId)}${adminQuery}`, { cache: "no-store", headers });
        if (stop) return Date.now() - started;
        if (response.status === 304) {
          failures.current = 0;
          if (!writingBeat.current) setReconnecting(false);
          return Date.now() - started;
        }
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            failures.current += 1;
            setReconnecting(true);
          }
          return Date.now() - started;
        }
        const nextTag = response.headers.get("x-council-digest") || response.headers.get("etag");
        if (nextTag) etag.current = nextTag;
        const data = (await response.json()) as Board;
        if (stop) return Date.now() - started;
        const ids = data.stickies.map((row) => row.id);
        if (seen.current) {
          const arrived = data.stickies.filter((row) => !seen.current?.has(row.id) && !row.late).map((row) => row.id);
          if (arrived.length > 0) {
            setFresh((current) => {
              const next = new Set(current);
              for (const id of arrived) next.add(id);
              return next;
            });
            window.setTimeout(() => {
              if (stop) return;
              setFresh((current) => {
                const next = new Set(current);
                for (const id of arrived) next.delete(id);
                return next;
              });
            }, 1200);
          }
        }
        seen.current = new Set(ids);
        setBoard(() => {
          const resolved = resolveBeat(data.meta, pendingBeat.current, ackedBeat.current);
          pendingBeat.current = resolved.pending;
          ackedBeat.current = resolved.acked;
          return { ...data, meta: resolved.meta };
        });
        failures.current = 0;
        if (!writingBeat.current) setReconnecting(false);
      } catch {
        if (!stop) {
          failures.current += 1;
          setReconnecting(true);
        }
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
  }, [key, sessionId]);

  function applyLocal(patch: Partial<Meta>) {
    const base = pendingBeat.current ?? ackedBeat.current ?? bag.current;
    const next = nextBeatMeta(
      { beat: base.beat, voteOpen: base.voteOpen, revealed: base.revealed, arrowsOn: base.arrowsOn },
      patch,
    );
    pendingBeat.current = next;
    bag.current = { ...bag.current, beat: next.beat, voteOpen: next.voteOpen, revealed: next.revealed, arrowsOn: next.arrowsOn };
    setBoard((current) => ({
      stickies: current?.stickies ?? [],
      admin: current?.admin ?? false,
      phones: current?.phones,
      meta: next,
    }));
  }

  async function writeBeat(snapshot: BeatMeta, generation: number) {
    writingBeat.current = true;
    let attempt = 0;
    while (alive.current && generation === beatWrite.current && pendingBeat.current && sameBeat(pendingBeat.current, snapshot)) {
      try {
        const response = await fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "phase", ...snapshot }),
        });
        if (!alive.current || generation !== beatWrite.current) return;
        if (response.ok) {
          if (pendingBeat.current && sameBeat(pendingBeat.current, snapshot)) {
            ackedBeat.current = snapshot;
            pendingBeat.current = null;
          }
          writingBeat.current = false;
          setReconnecting(false);
          return;
        }
        if (response.status !== 429 && response.status < 500) {
          writingBeat.current = false;
          setNote("Could not update the board");
          return;
        }
      } catch {
        /* The deck already shows the beat. Keep retrying the write. */
      }
      if (!alive.current || generation !== beatWrite.current) return;
      attempt += 1;
      setReconnecting(true);
      await new Promise((resolve) => window.setTimeout(resolve, reconnectDelayMs(attempt)));
    }
    if (generation === beatWrite.current) writingBeat.current = false;
  }

  function phase(patch: Partial<Meta>) {
    if (!key) {
      setNote("Admin key required for V, R, M, and E");
      return;
    }
    applyLocal(patch);
    const snapshot = pendingBeat.current;
    if (!snapshot) return;
    const generation = (beatWrite.current += 1);
    void writeBeat(snapshot, generation);
  }

  async function admin(action: "reset" | "seed") {
    const response = await fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, sessionId }),
    });
    const body = (await response.json()) as { error?: string; warning?: string };
    setNote(body.warning || body.error || (response.ok ? "Done" : "Admin action failed"));
    if (response.ok && action === "reset") setResetOpen(false);
  }

  async function downloadAll() {
    if (!key) {
      setNote("Export needs a valid admin key");
      return;
    }
    for (const format of ["html", "json", "csv"] as const) {
      const response = await fetch(`/api/council/export?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}&format=${format}`);
      if (!response.ok) {
        setNote("Export needs a valid admin key");
        return;
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = format === "html" ? `capture-sheet-${sessionId}.html` : `council-${sessionId}.${format}`;
      link.click();
      URL.revokeObjectURL(link.href);
    }
    setNote("Exported HTML, JSON, and CSV");
  }

  async function mergeInto(parentId: string, childId: string) {
    const response = await fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "merge", parentId, childId }),
    });
    setNote(response.ok ? "Merged" : "Could not merge those two");
    setPick("");
    setMerge(false);
  }

  async function split(stickyId: string) {
    const response = await fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "split", stickyId }),
    });
    setNote(response.ok ? "Split" : "Could not split");
  }

  async function hide(stickyId: string) {
    const response = await fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "hide", stickyId }),
    });
    if (!response.ok) {
      setNote("Could not hide that sticky");
      return;
    }
    setBoard((current) => (current ? { ...current, stickies: current.stickies.filter((row) => row.id !== stickyId) } : current));
    setSelected("");
  }

  async function label(stickyId: string) {
    const next = window.prompt("Two-word label for this stack", "");
    if (next === null) return;
    await fetch(`/api/council/admin?session=${encodeURIComponent(sessionId)}&admin=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "label", stickyId, label: next }),
    });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const state = bag.current;
      if (event.key === "ArrowRight" || event.key === "PageDown") void phase({ beat: Math.min(4, state.beat + 1) });
      if (event.key === "ArrowLeft" || event.key === "PageUp") void phase({ beat: Math.max(1, state.beat - 1) });
      if (event.key === "Home") void phase({ beat: 1 });
      if (event.key === "End") void phase({ beat: 4 });
      if (event.key === "f" || event.key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }
      if (event.key === "v" || event.key === "V") {
        if (state.beat === 2) void phase({ voteOpen: !state.voteOpen });
      }
      if (event.key === "r" || event.key === "R") {
        if (state.beat === 2) void phase({ revealed: !state.revealed });
        if (state.beat === 3) void phase({ arrowsOn: !state.arrowsOn });
      }
      if (event.key === "m" || event.key === "M") {
        if (event.shiftKey) {
          if (state.selected) void split(state.selected);
        } else if (state.beat === 2) {
          setMerge((value) => !value);
          setPick("");
        }
      }
      if (event.key === "e" || event.key === "E") void downloadAll();
      if (event.key === "h" || event.key === "H") setHideChrome((value) => !value);
      if (event.key === "p" || event.key === "P") setNotes((value) => !value);
      if (event.key === "?") setHelp((value) => !value);
      if (event.key === "l" || event.key === "L") setListColumn((current) => (current ? null : "all"));
      if (event.key === "n" || event.key === "N") setPageBump((value) => value + 1);
      if (event.key === "Escape") {
        setListColumn(null);
        setHelp(false);
        setNotes(false);
      }
      if (event.key === "Backspace" && state.selected) {
        event.preventDefault();
        void hide(state.selected);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stickies = board?.stickies ?? [];
  const beat = meta.beat >= 1 && meta.beat <= 4 ? meta.beat : 1;
  const script = content?.beats.length === 4 ? content.beats : BEATS.map((item, index) => ({ ...item, notes: NOTES[index] ?? "" }));
  const current = script[beat - 1] ?? script[0];
  if (!current) return null;
  const columnLabels = content?.columns;
  const dotCount = stickies.reduce((sum, row) => sum + row.votes, 0);
  const phones = board?.phones ?? 0;
  const live = meta.voteOpen ? `${phones} phones · ${dotCount} dots placed` : `${phones} phones`;

  function onSticky(id: string) {
    if (merge) {
      if (!pick) setPick(id);
      else if (pick !== id) void mergeInto(pick, id);
      return;
    }
    setSelected(id);
  }

  return (
    <div className="stage-frame" style={{ ["--fit" as string]: String(fit) }}>
      <div className="stage-sizer">
      <main className={`stage beat-${beat}`}>
        <header className="hdr">
          <div className="main">
            <div className="beat">
              {current.kicker}
              {meta.voteOpen ? " · Vote open" : ""}
              {meta.revealed && beat === 2 ? " · Ranked" : ""}
            </div>
            <h1 className="title">{current.title}</h1>
          <p className="prompt">{current.prompt}</p>
        </div>
          {hideChrome ? null : (
            <div className="join">
              <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
              <div>
                <div className="url">
                  <small>Join on your phone. No login.</small>
                  {shortUrl}
                </div>
                <div className="live">
                  <span className="pulse" />
                  {live}
                  {reconnecting ? " · reconnecting…" : ""}
                </div>
              </div>
            </div>
          )}
        </header>
        <div className="board">
        {beat === 1 ? <Framing copy={content?.framing} /> : null}
        {beat === 2 ? (
          <Hiring
            labels={columnLabels ? { pm: columnLabels.pm, channel: columnLabels.channel } : undefined}
            stickies={stickies.filter((row) => row.column === "pm" || row.column === "channel")}
            revealed={meta.revealed}
            selected={selected}
            pick={pick}
            fresh={fresh}
            pageBump={pageBump}
            onSticky={onSticky}
            onMore={setListColumn}
            onLabel={(id) => void label(id)}
          />
        ) : null}
        {beat === 3 ? <Quad stickies={stickies.filter((row) => row.column === "testing")} arrows={meta.arrowsOn} fresh={fresh} onMore={() => setListColumn("testing")} /> : null}
        {beat === 4 ? <Harvest stickies={stickies.filter((row) => row.column === "harvest")} fresh={fresh} onMore={() => setListColumn("harvest")} /> : null}
        </div>
        {hideChrome ? null : (
          <footer className="foot">
            <div>
              <span className="kbd">←</span>
              <span className="kbd">→</span>
              beats
              <span className="kbd">V</span>
              vote
              <span className="kbd">R</span>
              reveal
              <span className="kbd">M</span>
              merge
              <span className="kbd">F</span>
              full
              <span className="kbd">E</span>
              export
              {adminOn && selected ? (
                <button className="btn" style={{ width: "auto", minHeight: 44, margin: "0 0 0 12px", padding: "0 12px" }} type="button" onClick={() => void hide(selected)}>
                  Hide
                </button>
              ) : null}
              {adminOn ? (
                <>
                  <button className="btn alt" style={{ width: "auto", minHeight: 44, margin: "0 0 0 12px", padding: "0 12px" }} onClick={() => void downloadAll()}>
                    Export
                  </button>
                  <button className="btn alt" style={{ width: "auto", minHeight: 44, margin: "0 0 0 8px", padding: "0 12px" }} onClick={() => void admin("seed")}>
                    Seed demo data
                  </button>
                  <button className="btn" style={{ width: "auto", minHeight: 44, margin: "0 0 0 8px", padding: "0 12px" }} onClick={() => setResetOpen(true)}>
                    Reset session
                  </button>
                </>
              ) : null}
            </div>
            <div className="status">{note || (merge ? "Merge: click two stickies" : reconnecting ? "reconnecting…" : `${beat} / 4`)}</div>
          </footer>
        )}
        {resetOpen ? (
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <form
              className="sheet"
              onSubmit={(event) => {
                event.preventDefault();
                if (typed === sessionId) void admin("reset");
              }}
            >
              <h2 id="reset-title" className="hand" style={{ fontSize: 36 }}>
                Reset this session?
              </h2>
              <p className="ph-prompt">Type {sessionId} to wipe stickies, votes, the 2x2, and harvest. Other sessions stay.</p>
              <input aria-label="Session id" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
              <button className="btn" type="submit" disabled={typed !== sessionId}>
                Wipe {sessionId}
              </button>
              <button className="btn alt" type="button" onClick={() => setResetOpen(false)}>
                Cancel
              </button>
            </form>
          </div>
        ) : null}
        {help ? (
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <div className="sheet">
              <h2 id="help-title" className="hand" style={{ fontSize: 36 }}>Keys</h2>
              <p className="ph-prompt">← → beats. V vote. R reveal or hide arrows. M merge, Shift+M split. F fullscreen. E export. H hides the key bar. N next page. L full list. P notes. Backspace hides the selected sticky. Keys wait while you are typing.</p>
              <button className="btn alt" type="button" onClick={() => setHelp(false)}>Close</button>
            </div>
          </div>
        ) : null}
        {notes ? (
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="notes-title">
            <div className="sheet">
              <h2 id="notes-title" className="hand" style={{ fontSize: 36 }}>{current.kicker}</h2>
              <p className="ph-prompt">{current.notes}</p>
              <button className="btn alt" type="button" onClick={() => setNotes(false)}>Close</button>
            </div>
          </div>
        ) : null}
        {listColumn ? (
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="list-title">
            <div className="sheet full-list">
              <h2 id="list-title" className="hand" style={{ fontSize: 36 }}>{listColumn === "all" ? "Every sticky" : listTitle(listColumn, columnLabels)}</h2>
              <p className="ph-prompt">{listed(stickies, listColumn).length} on this beat. Scroll the full set, or press N to page the wall.</p>
              {listed(stickies, listColumn).map((row) => (
                <article key={row.id} className={`sticky ${tone(row.column)} ${selected === row.id ? "focus" : ""}`} style={{ marginTop: 10 }} onClick={() => onSticky(row.id)}>
                  <div className="txt">{row.text}</div>
                  {row.author ? <div className="by">{row.author}</div> : null}
                  {row.late ? <span className="late-flag">Late</span> : null}
                </article>
              ))}
              {adminOn && selected ? (
                <button className="btn" type="button" onClick={() => void hide(selected)}>Hide</button>
              ) : null}
              <button className="btn alt" type="button" onClick={() => setListColumn(null)}>Close</button>
            </div>
          </div>
        ) : null}
      </main>
      </div>
    </div>
  );
}

function listed(stickies: Row[], column: string): Row[] {
  if (column === "all") return stickies.filter((row) => row.column === "pm" || row.column === "channel");
  if (column === "designer") return [];
  return stickies.filter((row) => row.column === column);
}

function listTitle(column: string, labels?: BoardCopy["columns"]): string {
  if (column === "pm") return labels?.pm ?? "PM skills";
  if (column === "channel") return labels?.channel ?? "Where to hunt";
  if (column === "testing") return labels?.testing ?? "Testing";
  return labels?.harvest ?? "Harvest";
}

function Framing({ copy }: { copy?: BoardCopy["framing"] }) {
  return (
    <div>
      <div className="barbell">
        <div className="plate">
          <h3 className="hand" style={{ fontSize: 40 }}>{copy?.leadsTitle ?? "Leads"}</h3>
          <p className="copy">{copy?.leadsBody ?? "The work that needs a lead"}</p>
        </div>
        <div className="rod">
          <h3 className="hand" style={{ fontSize: 36, color: "var(--teal-ink)" }}>{copy?.middleTitle ?? "The middle"}</h3>
          <p className="copy">{copy?.middleBody ?? "What sits between the two ends"}</p>
        </div>
        <div className="plate">
          <h3 className="hand" style={{ fontSize: 40 }}>{copy?.buildersTitle ?? "Builders"}</h3>
          <p className="copy">{copy?.buildersBody ?? "The work that needs a maker"}</p>
        </div>
      </div>
      <div className="gap">
        <h4 className="hand" style={{ fontSize: 32 }}>{copy?.gap1Title ?? "Gap 1 · Hiring"}</h4>
        <p className="copy">{copy?.gap1Body ?? "Where the room is short on people."}</p>
      </div>
      <div className="gap">
        <h4 className="hand" style={{ fontSize: 32 }}>{copy?.gap2Title ?? "Gap 2 · Testing"}</h4>
        <p className="copy">{copy?.gap2Body ?? "Where the room ships more than it can validate."}</p>
      </div>
    </div>
  );
}

function Hiring({
  stickies,
  revealed,
  selected,
  pick,
  fresh,
  pageBump,
  onSticky,
  onMore,
  onLabel,
  labels,
}: {
  labels?: { pm: string; channel: string };
  stickies: Row[];
  revealed: boolean;
  selected: string;
  pick: string;
  fresh: Set<string>;
  pageBump: number;
  onSticky: (id: string) => void;
  onMore: (column: string | null) => void;
  onLabel: (id: string) => void;
}) {
  const columns = [
    ["pm", "PM skills", "var(--s-butter)"],
    ["channel", "Where to hunt", "var(--s-mint)"],
  ] as const;
  const named = columns.map(([id, label, color]) => [id, labels?.[id] ?? label, color] as const);
  return (
    <div className="wall">
      {named.map(([id, label, color]) => {
        const groups = clusterGroups(stickies, id, (stickyId) => stickies.find((row) => row.id === stickyId)?.votes ?? 0, revealed);
        const ranks = topRanks(groups, revealed);
        return (
          <ColumnBoard
            key={id}
            id={id}
            label={label}
            color={color}
            groups={groups}
            revealed={revealed}
            ranks={ranks}
            fresh={fresh}
            selected={selected}
            pick={pick}
            pageBump={pageBump}
            onSticky={onSticky}
            onMore={onMore}
            onLabel={onLabel}
          />
        );
      })}
    </div>
  );
}

function ColumnBoard({
  id,
  label,
  color,
  groups,
  revealed,
  ranks,
  fresh,
  selected,
  pick,
  pageBump,
  onSticky,
  onMore,
  onLabel,
}: {
  id: string;
  label: string;
  color: string;
  groups: { root: Row; members: Row[]; votes: number }[];
  revealed: boolean;
  ranks: Map<string, number>;
  fresh: Set<string>;
  selected: string;
  pick: string;
  pageBump: number;
  onSticky: (id: string) => void;
  onMore: (column: string | null) => void;
  onLabel: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const guess = fitStickyLayout(groups.length, 520, 620, revealed ? 250 : 121);
  const [across, setAcross] = useState(guess.across);
  const [font, setFont] = useState(guess.font);
  const [pageCounts, setPageCounts] = useState<number[]>([Math.max(1, guess.pageSize)]);
  const [page, setPage] = useState(0);
  const seenBump = useRef(pageBump);
  const measured = useRef("");
  const contentKey = groups
    .map((group) => `${group.root.id}\n${group.root.text}\n${group.votes}\n${group.members.length}\n${group.root.late ? 1 : 0}\n${group.root.label}`)
    .join("\n");

  useLayoutEffect(() => {
    const el = ref.current;
    const probe = probeRef.current;
    if (!el || !probe) return;
    function measure() {
      if (!el || !probe) return;
      const style = getComputedStyle(el);
      const pad = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const columnGap = Number.parseFloat(style.columnGap);
      const width = el.clientWidth;
      const height = Math.max(40, el.clientHeight - pad);
      const columnWidth = (width - padX - (Number.isFinite(columnGap) ? columnGap : 12) * Math.max(0, across - 1)) / Math.max(1, across);
      probe.style.width = `${Math.max(40, columnWidth)}px`;
      const heights: number[] = [];
      for (const card of probe.querySelectorAll<HTMLElement>(".sticky")) heights.push(card.offsetHeight);
      if (groups.length > 0 && heights.length === 0) return;
      const sample = probe.querySelector(".more");
      const buttonHeight = sample instanceof HTMLElement
        ? sample.offsetHeight + (Number.parseFloat(getComputedStyle(sample).marginTop) || 0)
        : 52;
      const signature = `${Math.round(width)}x${Math.round(height)}:${buttonHeight}:${heights.join(",")}:${font}`;
      if (measured.current === signature) return;
      measured.current = signature;
      setAcross(2);
      setFont(28);
      setPageCounts(stickyPages(heights, height, buttonHeight, across));
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [across, contentKey, font, groups.length, revealed]);

  useEffect(() => {
    setPage((current) => (current >= pageCounts.length ? Math.max(0, pageCounts.length - 1) : current));
  }, [pageCounts]);

  useEffect(() => {
    if (pageBump === seenBump.current) return;
    seenBump.current = pageBump;
    setPage((current) => (current + 1) % Math.max(1, pageCounts.length));
  }, [pageBump, pageCounts]);

  const ordered = revealed ? groups : [...groups].reverse();
  const start = pageCounts.slice(0, page).reduce((sum, count) => sum + count, 0);
  const shown = ordered.slice(start, start + Math.max(0, pageCounts[page] ?? 0));
  const extra = remainingStickies(ordered.length, start, shown.length);
  return (
    <section className="col">
      <div className="colh">
        <span className="chip" style={{ background: color }} />
        {label}
        <span className="n">{groups.length}</span>
      </div>
      <div className="grid" ref={ref} style={{ ["--across" as string]: across, position: "relative" }}>
        {groups.length === 0 ? <p className="hand" style={{ fontSize: 40, color: "var(--ink-soft)" }}>Waiting for the first one...</p> : null}
        {shown.map((group) => (
          <StickyCard
            key={group.root.id}
            columnId={id}
            group={group}
            font={font}
            rank={ranks.get(group.root.id)}
            arrived={fresh.has(group.root.id) && !group.root.late}
            focused={selected === group.root.id || pick === group.root.id}
            onSticky={onSticky}
            onLabel={onLabel}
          />
        ))}
        {extra > 0 ? (
          <button className="btn alt more" type="button" onClick={() => onMore(id)}>
            +{extra} more
          </button>
        ) : null}
        <div
          ref={probeRef}
          aria-hidden="true"
          style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", left: 0, top: 0, display: "flex", flexDirection: "column" }}
        >
          {ordered.map((group) => (
            <StickyCard
              key={`probe-${group.root.id}`}
              columnId={id}
              group={group}
              font={font}
              rank={ranks.get(group.root.id)}
              arrived={false}
              focused={false}
            />
          ))}
          <button className="btn alt more" type="button" tabIndex={-1}>
            +0 more
          </button>
        </div>
      </div>
    </section>
  );
}

function StickyCard({
  columnId,
  group,
  font,
  rank,
  arrived,
  focused,
  onSticky,
  onLabel,
}: {
  columnId: string;
  group: { root: Row; members: Row[]; votes: number };
  font: number;
  rank: number | undefined;
  arrived: boolean;
  focused: boolean;
  onSticky?: (id: string) => void;
  onLabel?: (id: string) => void;
}) {
  return (
    <article
      className={`sticky ${tone(columnId)} ${group.members.length > 1 ? "stack" : ""} ${arrived ? "new" : ""} ${focused ? "focus" : ""}`}
      style={{ ["--r" as string]: `${tilt(group.root.id)}deg`, fontSize: font }}
      onClick={onSticky ? () => onSticky(group.root.id) : undefined}
      onDoubleClick={onLabel ? () => onLabel(group.root.id) : undefined}
    >
      {group.members.length > 1 ? <span className="xn">x{group.members.length}</span> : null}
      {group.votes > 0 ? <span className="votes">{group.votes}</span> : null}
      {rank ? <span className="rank">{rank}</span> : null}
      {group.root.label ? <span className="hand" style={{ fontSize: Math.max(24, font) }}>{group.root.label}</span> : null}
      <div className="txt">{group.root.text}</div>
      {group.root.late ? <span className="late-flag">Late</span> : null}
      {group.votes > 0 ? (
        <div className="dots">
          {Array.from({ length: Math.min(group.votes, 8) }, (_, index) => (
            <span className="dot" key={index} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function Quad({ stickies, arrows, fresh, onMore }: { stickies: Row[]; arrows: boolean; fresh: Set<string>; onMore: () => void }) {
  const placed = stickies.filter((row) => row.today && row.year);
  const average = placed.length >= 3 ? meanArrow(placed) : null;
  const ownership = average ? Math.round((average.yx - average.tx) * 100) : 0;
  const rigor = average ? Math.round((average.yy - average.ty) * 100) : 0;
  const svgRef = useRef<SVGSVGElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const [stretch, setStretch] = useState(1);
  const [railShown, setRailShown] = useState(stickies.length);
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function measure() {
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setStretch(box.height / box.width);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setRailShown(stickies.length);
  }, [stickies.length]);
  useEffect(() => {
    const el = railRef.current;
    if (!el || el.clientHeight < 40) return;
    if (el.scrollHeight <= el.clientHeight + 2) return;
    setRailShown((current) => Math.max(0, current - 1));
  }, [railShown, stickies.length, stretch]);
  const railRows = stickies.slice(0, railShown);
  const railExtra = stickies.length - railRows.length;
  return (
    <div className="board-row">
      <div className="plot" aria-label="Testing grid. Left is one owner. Right is every PM owns it. Bottom is directional. Top is statistical.">
        <svg ref={svgRef} viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none" role="img">
          <defs>
            <marker id="council-arrow" markerUnits="userSpaceOnUse" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0 0 L10 5 L0 10 Z" fill="#2B2118" />
            </marker>
          </defs>
          <rect x="2" y="2" width="96" height="96" fill="none" stroke="#2B2118" strokeWidth="1.2" />
          <path d="M50 2 V98 M2 50 H98" stroke="#2B2118" strokeWidth="0.8" />
          {placed.map((row) => {
            const x1 = pct(row.today!.x);
            const y1 = pct(1 - row.today!.y);
            const x2 = pct(row.year!.x);
            const y2 = pct(1 - row.year!.y);
            const bend = curveOffset(row.id) / 30;
            return (
              <g key={row.id}>
                {arrows ? (
                  <path
                    d={`M ${x1} ${y1} Q ${(x1 + x2) / 2 + bend} ${(y1 + y2) / 2 + bend} ${x2} ${y2}`}
                    fill="none"
                    stroke="#2B2118"
                    strokeOpacity="0.55"
                    strokeWidth="0.8"
                    markerEnd="url(#council-arrow)"
                  />
                ) : null}
                <ellipse cx={x1} cy={y1} rx={2.2 * stretch} ry={2.2} fill="#1F6F78" stroke="#2B2118" strokeWidth="0.6" />
                <ellipse cx={x2} cy={y2} rx={2.6 * stretch} ry={2.6} fill="#E4572E" stroke="#2B2118" strokeWidth="0.6" />
                <ellipse cx={x2} cy={y2} rx={stretch} ry={1} fill="#FBF4E6" />
              </g>
            );
          })}
          {average && arrows ? (
            <g>
              <line x1={pct(average.tx)} y1={pct(1 - average.ty)} x2={pct(average.yx)} y2={pct(1 - average.yy)} stroke="#FBF4E6" strokeWidth="2.4" />
              <line x1={pct(average.tx)} y1={pct(1 - average.ty)} x2={pct(average.yx)} y2={pct(1 - average.yy)} stroke="#2B2118" strokeWidth="1.3" markerEnd="url(#council-arrow)" />
            </g>
          ) : null}
        </svg>
        <div className="q-label tl"><b>Test team</b><span>A specialist owns the tests</span></div>
        <div className="q-label tr"><b>Every PM experiments</b><span>Each PM runs their own</span></div>
        <div className="q-label bl"><b>Research desk</b><span>One owner, directional</span></div>
        <div className="q-label br"><b>Everyone talks to users</b><span>Every PM, directional</span></div>
        <div className="hand axis-top">A/B tests</div>
        <div className="hand axis-bottom">Talking to users</div>
        <div className="hand axis-left">← One owner</div>
        <div className="hand axis-right">Every PM owns it →</div>
      </div>
      <aside className="rail" ref={railRef}>
        <div className="legend">
          <span className="lg"><span className="d-today" />Today</span>
          <span className="lg"><span className="d-year" />In 1 year</span>
        </div>
        {average ? (
          <p className="hand" style={{ fontSize: 40, color: "var(--tomato-ink)", marginBottom: 12 }}>
            Shift: {ownership >= 0 ? "+" : ""}{ownership}% ownership, {rigor >= 0 ? "+" : ""}{rigor}% rigor
          </p>
        ) : (
          <p className="hand" style={{ fontSize: 32, color: "var(--ink-soft)", marginBottom: 12 }}>Room average after 3 placements</p>
        )}
        {railRows.map((row) => (
          <article key={row.id} className={`sticky sky ${fresh.has(row.id) && !row.late ? "new" : ""}`} style={{ ["--r" as string]: `${tilt(row.id)}deg`, marginBottom: 12 }}>
            <div className="txt">{row.text}</div>
            {row.late ? <span className="late-flag">Late</span> : null}
          </article>
        ))}
        {railExtra > 0 ? (
          <button className="btn alt more" type="button" onClick={onMore}>+{railExtra} more</button>
        ) : null}
      </aside>
    </div>
  );
}

function Harvest({ stickies, fresh, onMore }: { stickies: Row[]; fresh: Set<string>; onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const guess = fitStickyLayout(stickies.length, 1600, 640);
  const [across, setAcross] = useState(guess.across);
  const [font, setFont] = useState(Math.max(28, guess.font));
  const [pageSize, setPageSize] = useState(guess.pageSize);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function measure() {
      if (!el) return;
      const fit = fitStickyLayout(stickies.length, el.clientWidth, el.clientHeight);
      setAcross(Math.max(4, fit.across));
      setFont(Math.max(28, fit.font));
      setPageSize(fit.pageSize);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stickies.length]);
  const shown = stickies.slice(0, pageSize);
  const extra = stickies.length - shown.length;
  return (
    <div className="harvest" ref={ref} style={{ ["--across" as string]: across, ["--fs" as string]: `${font}px` }}>
      {stickies.length === 0 ? <p className="hand" style={{ fontSize: 40, color: "var(--ink-soft)" }}>Waiting for the first offer...</p> : null}
      {shown.map((row) => (
        <article key={row.id} className={`sticky lilac ${fresh.has(row.id) && !row.late ? "new" : ""}`} style={{ ["--r" as string]: `${tilt(row.id)}deg`, fontSize: font }}>
          <div>
            <span className="lead">I&apos;ll give you</span>
            <span className="txt">{row.text}</span>
          </div>
          <div className="by">{row.author || "Anonymous"}</div>
          {row.late ? <span className="late-flag">Late</span> : null}
        </article>
      ))}
      {extra > 0 ? (
        <button className="btn alt more" type="button" onClick={onMore}>+{extra} more</button>
      ) : null}
    </div>
  );
}

function meanArrow(rows: Row[]) {
  const tx = rows.reduce((sum, row) => sum + row.today!.x, 0) / rows.length;
  const ty = rows.reduce((sum, row) => sum + row.today!.y, 0) / rows.length;
  const yx = rows.reduce((sum, row) => sum + row.year!.x, 0) / rows.length;
  const yy = rows.reduce((sum, row) => sum + row.year!.y, 0) / rows.length;
  return { tx, ty, yx, yy };
}

function tone(column: string): string {
  if (column === "designer") return "coral";
  if (column === "channel") return "mint";
  if (column === "testing") return "sky";
  if (column === "harvest") return "lilac";
  return "butter";
}

function decodeHash(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tilt(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2][hash % 9];
}

function pct(value: number): number {
  return 4 + value * 92;
}
