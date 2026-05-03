import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { announceCardShow, announceShow, resumeAudio } from "./audio";

type CardModel = { id: string; name: string };

type RoomPayload = {
  phase: string;
  countdownEndsAt: number | null;
  passDeadlineAt: number | null;
  players: { id: string; name: string; seat?: number }[];
  selfId?: string;
  round: number;
  starterIndex: number;
  /** Who must tap a card now (one turn at a time). */
  currentTurnPlayerId?: string | null;
  lastEvent?:
    | { type: "card_show" | "show"; playerId?: string; name?: string; at: number }
    | undefined;
  winnerId?: string;
};

type ServerState = {
  room: RoomPayload;
  myHand: CardModel[];
  leaderboard: { rank: number; playerId: string; name: string; prize: number }[];
  generation: number;
};

const LS_NAME = "showgame:name";
const LS_ROOM = "showgame:room";
const LS_PID = "showgame:playerId";

/**
 * Production builds must set VITE_SOCKET_URL to wherever Node runs `server/index.ts` (Render, Railway, Fly, VPS…).
 * Vercel serves only static HTML/JS — it cannot host Socket.IO, so never leave this unset in prod or the browser will try same-origin `showgame.vercel.app` and fail WebSocket upgrades.
 */
const REALTIME_URL =
  import.meta.env.DEV
    ? "http://127.0.0.1:3001"
    : (import.meta.env.VITE_SOCKET_URL as string | undefined)?.trim() || null;

const MISSING_REALTIME = import.meta.env.PROD && REALTIME_URL === null;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad2(r)}`;
}

export default function App(): JSX.Element {
  const socketRef = useRef<Socket | null>(null);

  const [name, setName] = useState(() => window.localStorage.getItem(LS_NAME) ?? "");
  const [roomName, setRoomName] = useState(
    () => window.localStorage.getItem(LS_ROOM) ?? "family-evening",
  );
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<ServerState | null>(null);

  const [flashOverlay, setFlashOverlay] = useState<{
    kind: "card_show" | "show";
    title: string;
    body: string;
  } | null>(null);
  const flashKeyRef = useRef<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(LS_NAME, name);
  }, [name]);

  useEffect(() => {
    window.localStorage.setItem(LS_ROOM, roomName);
  }, [roomName]);

  useEffect(() => {
    if (MISSING_REALTIME || !REALTIME_URL) return;

    const s = io(REALTIME_URL, {
      path: "/socket.io",
      transports: ["polling", "websocket"],
      autoConnect: true,
    });
    socketRef.current = s;

    const onState = (p: ServerState) => {
      setSnapshot(p);
    };

    const onErr = (msg: string) => setError(msg);
    const onConnectErr = () =>
      setError(
        "Cannot reach the realtime server. Check VITE_SOCKET_URL and that the API process is running.",
      );

    s.on("state", onState);
    s.on("error_msg", onErr);
    s.on("connect_error", onConnectErr);

    return () => {
      s.off("state", onState);
      s.off("error_msg", onErr);
      s.off("connect_error", onConnectErr);
      s.disconnect();
      socketRef.current = null;
    };
  }, []);

  /** Full-screen + spoken announcements once per server event (CARD SHOW does not remove cards). */
  useEffect(() => {
    const ev = snapshot?.room.lastEvent;
    if (!ev || !snapshot) return;
    const k = `${ev.type}-${ev.at}-${ev.playerId ?? ""}-${ev.name ?? ""}`;
    if (flashKeyRef.current === k) return;
    flashKeyRef.current = k;

    const playerName =
      ev.playerId != null
        ? snapshot.room.players.find((p) => p.id === ev.playerId)?.name ?? "Player"
        : "Player";

    void resumeAudio();

    if (ev.type === "card_show") {
      const cardName = ev.name ?? "";
      setFlashOverlay({
        kind: "card_show",
        title: "CARD SHOW",
        body: `${playerName} calls card show on ${cardName}. All four cards stay in your hand.`,
      });
      announceCardShow(cardName);
      window.setTimeout(() => setFlashOverlay(null), 2800);
    } else {
      const cardName = ev.name ?? "";
      setFlashOverlay({
        kind: "show",
        title: "SHOW",
        body: `${playerName} wins with four ${cardName}.`,
      });
      announceShow(cardName, playerName);
      window.setTimeout(() => setFlashOverlay(null), 3800);
    }
  }, [snapshot]);

  /** Recomputed every tick so lobby / pass timers visibly count down (not frozen in useMemo). */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  const lobbyMs = useMemo(() => {
    if (!snapshot?.room.countdownEndsAt || snapshot.room.phase !== "countdown") {
      return null;
    }
    return snapshot.room.countdownEndsAt - Date.now();
  }, [snapshot, tick]);

  const passMs = useMemo(() => {
    if (!snapshot?.room.passDeadlineAt || snapshot.room.phase !== "passing") {
      return null;
    }
    return snapshot.room.passDeadlineAt - Date.now();
  }, [snapshot, tick]);

  const join = useCallback(() => {
    if (MISSING_REALTIME || !socketRef.current) {
      setError(
        "Deploy error: set environment variable VITE_SOCKET_URL in Vercel to your Game API URL (where Node + Socket.IO runs).",
      );
      return;
    }
    setError(null);
    const pid = window.localStorage.getItem(LS_PID);
    socketRef.current.emit("join", {
      roomName,
      playerName: name,
      ...(pid ? { playerId: pid } : {}),
    });
    setJoined(true);
    void resumeAudio();
  }, [name, roomName]);

  useEffect(() => {
    const s = snapshot;
    const selfId = s?.room.selfId;
    if (selfId) window.localStorage.setItem(LS_PID, selfId);
  }, [snapshot]);

  const onPickCard = (index: number) => {
    if (!snapshot || snapshot.room.phase !== "passing") return;
    if (snapshot.room.selfId !== snapshot.room.currentTurnPlayerId) return;
    socketRef.current?.emit("pass_card", { cardIndex: index });
  };

  const onShowTap = async () => {
    await resumeAudio();
    socketRef.current?.emit("show_claim");
  };

  const onPlayAgain = () => {
    socketRef.current?.emit("play_again");
  };

  const onStartGameNow = () => {
    socketRef.current?.emit("start_game");
  };

  const copyInviteLink = useCallback(() => {
    void navigator.clipboard?.writeText(window.location.href);
  }, []);

  const leaderboard = snapshot?.leaderboard ?? [];

  const playerCount = snapshot?.room.players.length ?? 0;

  const needsMorePlayers =
    playerCount < 4 &&
    snapshot &&
    (snapshot.room.phase === "countdown" || snapshot.room.phase === "waiting");

  const isMyTurn =
    !!snapshot &&
    snapshot.room.phase === "passing" &&
    !!snapshot.room.selfId &&
    snapshot.room.selfId === snapshot.room.currentTurnPlayerId;

  const activeTurnPlayer = useMemo(() => {
    if (!snapshot?.room.currentTurnPlayerId) return null;
    return snapshot.room.players.find((p) => p.id === snapshot.room.currentTurnPlayerId) ?? null;
  }, [snapshot]);

  /** Seat order 1→2→…→n→1: pass always goes to the next seat in the table list. */
  const passTargetName = useMemo(() => {
    if (!snapshot?.room.selfId || snapshot.room.players.length < 2 || !isMyTurn) return null;
    const seats = snapshot.room.players;
    const i = seats.findIndex((p) => p.id === snapshot.room.selfId);
    if (i < 0) return null;
    return seats[(i + 1) % seats.length]?.name ?? null;
  }, [snapshot, isMyTurn]);

  return (
    <div className="app">
      {flashOverlay && (
        <div
          className={`flash ${flashOverlay.kind === "card_show" ? "card-show" : ""}`}
          role="alert"
          aria-live="assertive"
        >
          <div className="flash-inner">
            <h2>{flashOverlay.title}</h2>
            <p style={{ opacity: 0.9, marginTop: 12, fontSize: "1.05rem" }}>{flashOverlay.body}</p>
          </div>
        </div>
      )}

      {MISSING_REALTIME && (
        <div
          role="alert"
          className="panel"
          style={{
            marginBottom: 16,
            borderColor: "rgba(255,110,120,0.5)",
            background: "rgba(80,20,30,0.35)",
          }}
        >
          <strong>Realtime server not configured for this build.</strong>
          <p className="meta" style={{ marginBottom: 0 }}>
            In the Vercel project, add <code>VITE_SOCKET_URL</code> pointing to your deployed Node API (same
            codebase, <code>server/index.ts</code> on Render / Railway / Fly / a VPS). Example:{" "}
            <code>https://showgame-api.onrender.com</code> — no trailing slash. Redeploy after saving. Vercel
            cannot host Socket.IO; only the static UI runs there.
          </p>
        </div>
      )}

      <header>
        <h1>SHOW · family card arena</h1>
        <p className="sub">
          Pick a memorable room phrase, invite up to nine more devices, gather four matching name cards,
          then race everyone else tapping <strong>Show</strong>.
        </p>
      </header>

      {!joined && (
        <section className="panel">
          <div className="row">
            <label>
              Your name on the cards
              <input
                value={name}
                placeholder="Ada"
                onChange={(e) => setName(e.target.value)}
                autoCapitalize="words"
              />
            </label>
            <label>
              Room phrase
              <input
                value={roomName}
                placeholder="sunday-snacks"
                onChange={(e) => setRoomName(e.target.value)}
              />
            </label>
            <button
              className="primary"
              type="button"
              disabled={name.trim().length === 0 || MISSING_REALTIME}
              onClick={join}
            >
              Enter arena
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          <p className="meta" style={{ marginTop: 16 }}>
            Card faces: RAMA, SITA, LAKSHMAN, HANUMAN, HE-MAN, SUPERMAN, JAMBA, VAALI, RAVAN, JETAYU · minimum{" "}
            <strong>four players</strong> to deal · max ten · seats are numbered by join order · two-minute lobby after
            the first arrival · same room phrase reunites the table.
          </p>
        </section>
      )}

      {joined && snapshot && (
        <>
          <section className="panel" style={{ marginBottom: 16 }}>
            <div className="row" style={{ alignItems: "center" }}>
              <strong>Room:</strong>&nbsp;<span>{roomName}</span>
              &nbsp;&nbsp;<span className="pill">Gen {snapshot.generation}</span>
            </div>
            {snapshot.room.phase === "countdown" && lobbyMs !== null && (
              <div className="countdown-banner">
                {playerCount < 4 ? (
                  <>
                    Lobby timer: <span>{formatRemaining(lobbyMs)}</span>
                    &nbsp;— cards cannot deal until <strong>four players</strong> join this room ({playerCount}/4
                    here).
                  </>
                ) : (
                  <>
                    Next deal in&nbsp;
                    <span>{formatRemaining(lobbyMs)}</span>
                    &nbsp;— or tap <strong>Start game now</strong> below when everyone is ready.
                  </>
                )}
              </div>
            )}
            {needsMorePlayers && (
              <div className="solo-callout" role="region" aria-label="What to do while waiting">
                <div className="solo-callout-title">Need four players</div>
                <p className="solo-callout-lead">
                  You have <strong>{playerCount} of 4</strong> players at this table. Every seat counts — passes move{" "}
                  <strong>Seat 1 → Seat 2 → … → back to Seat 1</strong>.
                </p>
                <ol className="solo-steps">
                  <li>
                    Tap <strong>Copy invite link</strong> (below or here) and send it on WhatsApp, SMS, or email.
                  </li>
                  <li>
                    Others open the link, use the <strong>same room phrase</strong> (<strong>{roomName}</strong>), enter
                    their name, tap <strong>Enter arena</strong>.
                  </li>
                  <li>
                    When <strong>four people</strong> are seated, <strong>Start game now</strong> appears — use it to
                    begin early, or wait for this timer.
                  </li>
                </ol>
                <p className="solo-callout-note">
                  If the timer hits zero before four players arrive, no cards deal yet — keep inviting until four join.
                </p>
                <button type="button" className="primary solo-copy-btn" onClick={copyInviteLink}>
                  Copy invite link
                </button>
              </div>
            )}
            {(snapshot.room.phase === "countdown" || snapshot.room.phase === "waiting") &&
              playerCount >= 4 && (
                <div style={{ marginTop: 14 }}>
                  <button type="button" className="primary" onClick={onStartGameNow}>
                    Start game now
                  </button>
                  <p className="meta" style={{ marginTop: 8, marginBottom: 0 }}>
                    If nobody taps this, the table still opens automatically when the two-minute lobby timer
                    finishes.
                  </p>
                </div>
              )}
            {(snapshot.room.phase === "waiting" || snapshot.room.phase === "game_over") && (
              <p className="meta">
                {snapshot.room.phase === "waiting"
                  ? "Waiting for enough family members to gather — share the phrase from your browser bar."
                  : "Hands are closed — leaderboard is final for this SHOW."}
              </p>
            )}
            {snapshot.room.phase === "countdown" && playerCount >= 4 && (
              <p className="meta">
                Four players in — use <strong>Start game now</strong> when you are ready, or wait for the timer.
              </p>
            )}
            {snapshot.room.phase === "passing" && activeTurnPlayer && (
              <div
                className={`turn-banner ${isMyTurn ? "turn-banner--yours" : ""}`}
                role="status"
                aria-live="polite"
              >
                {isMyTurn ? (
                  <>
                    <strong>Your turn</strong> — tap one card below to pass it to <strong>{passTargetName ?? "next"}</strong>{" "}
                    (next seat in the table).
                  </>
                ) : (
                  <>
                    Waiting for <strong>{activeTurnPlayer.name}</strong>
                    {activeTurnPlayer.seat ? <> · Seat {activeTurnPlayer.seat}</> : ""} to pass a card…
                  </>
                )}
              </div>
            )}
            {snapshot.room.phase === "passing" && (
              <div className="pass-callout" role="region" aria-label="Pass instructions">
                <div className="pass-callout-title">
                  Round {snapshot.room.round} · One turn at a time
                </div>
                <ol className="pass-steps">
                  <li>
                    Only the highlighted player taps <strong>one card</strong>. That card moves to the{" "}
                    <strong>next seat</strong> (Seat 1→2→…→n→1).
                  </li>
                  <li>
                    The player who receives may briefly hold <strong>five cards</strong>. They must tap one to pass on
                    within <strong>10 seconds</strong>. If time runs out, the <strong>right-hand card</strong> in their row
                    passes automatically.
                  </li>
                  <li>
                    After each pass, <strong>that receiver goes next</strong>, until someone collects four of the same
                    name and SHOW wins.
                  </li>
                </ol>
                <p className="pass-goal">
                  Seats follow join order: first person is Seat 1, second Seat 2, and passes always flow to the next
                  higher seat (wraps back to Seat 1).
                </p>
              </div>
            )}
            {snapshot.room.phase === "passing" && passMs !== null && (
              <div className="meta pass-timer-line">
                {isMyTurn ? (
                  <>
                    Your clock:&nbsp;
                    <strong>{formatRemaining(passMs)}</strong>
                    <span className="pass-status pick"> · Tap one card below.</span>
                  </>
                ) : (
                  <>
                    {activeTurnPlayer?.name ?? "Active"}&apos;s timer:&nbsp;
                    <strong>{formatRemaining(passMs)}</strong>
                    <span className="pass-status waiting"> · Sit tight.</span>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <h2 style={{ marginTop: 0, fontSize: "1.2rem" }}>Table order (pass goes → next)</h2>
            <div className="players">
              {snapshot.room.players.map((p, idx) => (
                <div
                  key={p.id}
                  className={`pill ${p.id === snapshot.room.selfId ? "you" : ""} ${
                    snapshot.room.phase === "passing" && p.id === snapshot.room.currentTurnPlayerId ? "pill-active" : ""
                  }`}
                >
                  Seat {p.seat ?? idx + 1} · {p.name}
                  {p.id === snapshot.room.players[snapshot.room.starterIndex]?.id ? " · opens table" : ""}
                </div>
              ))}
            </div>

            <h3 style={{ marginBottom: 4, fontSize: "1rem" }}>
              {snapshot.room.phase === "passing"
                ? "Your cards — tap one to pass"
                : snapshot.room.phase === "countdown"
                  ? "Your cards (not dealt yet)"
                  : "Your hand"}
            </h3>
            {snapshot.room.phase === "countdown" && snapshot.myHand.length === 0 && (
              <p className="empty-hand-hint">
                Nothing here until the hand starts — invite players above, then cards appear for everyone at once.
              </p>
            )}
            {snapshot.room.phase === "passing" && isMyTurn && passTargetName && (
              <p className="meta hand-hint">
                Your pass goes to Seat&nbsp;
                {snapshot.room.players[
                  (snapshot.room.players.findIndex((x) => x.id === snapshot.room.selfId) + 1) %
                    snapshot.room.players.length
                ]?.seat ?? "?"}{" "}
                · <strong>{passTargetName}</strong>
              </p>
            )}

            {(snapshot.room.phase === "passing" ||
              (snapshot.room.phase === "countdown" && snapshot.myHand.length > 0)) && (
              <div className={`hand ${snapshot.room.phase === "passing" && !isMyTurn ? "hand--locked" : ""}`}>
                {snapshot.myHand.map((c, idx) => (
                  <button
                    type="button"
                    key={c.id}
                    className="card"
                    disabled={snapshot.room.phase !== "passing" || !isMyTurn}
                    onClick={() => onPickCard(idx)}
                    aria-label={
                      isMyTurn
                        ? `Pass ${c.name} to ${passTargetName ?? "next player"}`
                        : `Not your turn — ${c.name}`
                    }
                  >
                    <span className="card-name">{c.name}</span>
                    <span className="card-action">
                      {snapshot.room.phase === "passing"
                        ? isMyTurn
                          ? `Tap → ${passTargetName ?? "next"}`
                          : "Wait — not your turn"
                        : "Deal opens soon"}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {(snapshot.room.phase === "waiting" || snapshot.room.phase === "game_over") && (
              <p className="meta">
                Hands stay hidden whenever the room is idle so late cousins cannot peek.&nbsp;
                {snapshot.room.phase === "game_over"
                  ? "Scroll for the leaderboard and queue another round whenever you miss the chaos."
                  : ""}
              </p>
            )}
          </section>

          {leaderboard.length > 0 && snapshot.room.phase === "game_over" && (
            <section className="panel leader">
              <strong>Standing & souvenir rupee scores</strong>
              <div className="leader-grid">
                {leaderboard.map((row) => (
                  <div key={row.playerId + row.rank} className="leader-row">
                    <span>
                      <span className="badge-rank">{row.rank}.</span> {row.name}
                    </span>
                    <span>₹ {row.prize.toLocaleString()}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="primary"
                style={{ marginTop: 16 }}
                onClick={onPlayAgain}
              >
                Play another SHOW in this room phrase
              </button>
              <p className="meta" style={{ marginTop: 10 }}>
                Invite everyone who wants another scramble — when at least four people tap Play Again we start a fresh
                two-minute countdown with only those returners.
              </p>
            </section>
          )}

          <div className="show-strip">
            <button
              type="button"
              className="primary"
              disabled={snapshot.room.phase !== "game_over"}
              onClick={onShowTap}
            >
              Show
            </button>
            <button type="button" onClick={copyInviteLink}>
              Copy invite link
            </button>
          </div>
        </>
      )}
    </div>
  );
}
