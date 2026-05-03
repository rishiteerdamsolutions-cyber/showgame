import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  announceShow,
  ensureAudioUnlocked,
  getEffectiveSoundLevel,
  waitForShowCelebration,
  getSoundMuted,
  getSoundVolume,
  playCardPassSound,
  playCountdownTick,
  primeAudioPlayback,
  SOUND_SETTINGS_EVENT,
  setSoundMuted,
  setSoundVolume,
  stopBackgroundMusic,
} from "./audio";
import {
  CARD_FACE_LABELS,
  labelForCardFace,
  MARVEL_CARD_NAMES,
  slugForCardFace,
} from "@shared/cardNames";

const CARD_LIST_BLURB = MARVEL_CARD_NAMES.map((t) => CARD_FACE_LABELS[t]).join(" · ");

type CardModel = { id: string; name: string };

type RoomPayload = {
  phase: string;
  countdownEndsAt: number | null;
  passDeadlineAt: number | null;
  players: { id: string; name: string; seat?: number }[];
  selfId?: string;
  round: number;
  starterIndex: number;
  currentTurnPlayerId?: string | null;
  lastEvent?:
    | { type: "card_show" | "show"; playerId?: string; name?: string; at: number }
    | undefined;
  winnerId?: string;
  playAgainIds: string[];
  playAgainQuorum: number;
  passSinceDeal: number;
  sessionPlayersAtLock: number | null;
  sessionGamesCompleted: number;
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

  const [flashOverlay, setFlashOverlay] = useState<{ title: string; body: string } | null>(null);
  const flashKeyRef = useRef<string | null>(null);
  const celebrationIdRef = useRef(0);
  const [, setSoundUi] = useState(0);
  const prevPassSinceRef = useRef(0);
  const prevPassGenRef = useRef<number | null>(null);
  const prevPassTimerSecRef = useRef<number | null>(null);
  const prevLobbyTimerSecRef = useRef<number | null>(null);

  useEffect(() => { window.localStorage.setItem(LS_NAME, name); }, [name]);
  useEffect(() => { window.localStorage.setItem(LS_ROOM, roomName); }, [roomName]);

  useEffect(() => {
    if (MISSING_REALTIME || !REALTIME_URL) return;
    const s = io(REALTIME_URL, {
      path: "/socket.io",
      transports: ["polling", "websocket"],
      autoConnect: true,
    });
    socketRef.current = s;
    const onState = (p: ServerState) => setSnapshot(p);
    const onErr = (msg: string) => setError(msg);
    const onConnectErr = () =>
      setError("Cannot reach the realtime server. Check VITE_SOCKET_URL and that the API process is running.");
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
    if (ev.type === "card_show") {
      /* CARD SHOW UI disabled — only SHOW / WINNER celebration for a winning hand */
      return;
    }
    const cardName = ev.name ?? "";
    const celId = ++celebrationIdRef.current;
    setFlashOverlay({
      title: "SHOW!",
      body: `${playerName} wins with four ${labelForCardFace(cardName)}`,
    });
    void (async () => {
      await ensureAudioUnlocked();
      await waitForShowCelebration(announceShow(cardName, playerName));
      if (celebrationIdRef.current === celId) setFlashOverlay(null);
    })();
  }, [snapshot]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  const lobbyMs = useMemo(() => {
    if (!snapshot?.room.countdownEndsAt || snapshot.room.phase !== "countdown") return null;
    return snapshot.room.countdownEndsAt - Date.now();
  }, [snapshot, tick]);

  const passMs = useMemo(() => {
    if (!snapshot?.room.passDeadlineAt || snapshot.room.phase !== "passing") return null;
    return snapshot.room.passDeadlineAt - Date.now();
  }, [snapshot, tick]);

  /** Pass timer: tick sound each time the displayed second drops */
  useEffect(() => {
    prevPassTimerSecRef.current = null;
  }, [snapshot?.room.passDeadlineAt]);

  useEffect(() => {
    if (snapshot?.room.phase !== "passing" || passMs === null || passMs <= 0) return;
    const sec = Math.ceil(passMs / 1000);
    if (prevPassTimerSecRef.current !== null && sec < prevPassTimerSecRef.current) {
      playCountdownTick();
    }
    prevPassTimerSecRef.current = sec;
  }, [snapshot?.room.phase, snapshot?.room.passDeadlineAt, passMs, tick]);

  /** Lobby timer: same countdown tick */
  useEffect(() => {
    prevLobbyTimerSecRef.current = null;
  }, [snapshot?.room.countdownEndsAt]);

  useEffect(() => {
    if (snapshot?.room.phase !== "countdown" || lobbyMs === null || lobbyMs <= 0) return;
    const sec = Math.ceil(lobbyMs / 1000);
    if (prevLobbyTimerSecRef.current !== null && sec < prevLobbyTimerSecRef.current) {
      playCountdownTick();
    }
    prevLobbyTimerSecRef.current = sec;
  }, [snapshot?.room.phase, snapshot?.room.countdownEndsAt, lobbyMs, tick]);

  /** Card pass whoosh — server increments passSinceDeal on every pass */
  useEffect(() => {
    if (!snapshot) return;
    const gen = snapshot.generation;
    const n = snapshot.room.passSinceDeal ?? 0;
    if (prevPassGenRef.current !== gen) {
      prevPassGenRef.current = gen;
      prevPassSinceRef.current = n;
      return;
    }
    if (snapshot.room.phase === "passing" && n > prevPassSinceRef.current) {
      playCardPassSound();
    }
    prevPassSinceRef.current = n;
  }, [snapshot]);

  /** Stop BGM when leaving the arena */
  useEffect(() => {
    if (!joined) stopBackgroundMusic();
  }, [joined]);

  const join = useCallback(async () => {
    if (MISSING_REALTIME || !socketRef.current) {
      setError("Deploy error: set VITE_SOCKET_URL in Vercel to your Game API URL.");
      return;
    }
    await ensureAudioUnlocked();
    setError(null);
    const pid = window.localStorage.getItem(LS_PID);
    socketRef.current.emit("join", { roomName, playerName: name, ...(pid ? { playerId: pid } : {}) });
    setJoined(true);
  }, [name, roomName]);

  /** First tap anywhere after joining unlocks audio on strict browsers (iOS Safari). */
  useEffect(() => {
    if (!joined) return;
    const onFirstTap = () => {
      primeAudioPlayback();
      window.removeEventListener("pointerdown", onFirstTap, true);
    };
    window.addEventListener("pointerdown", onFirstTap, { capture: true });
    return () => window.removeEventListener("pointerdown", onFirstTap, true);
  }, [joined]);

  useEffect(() => {
    const sync = () => setSoundUi((n) => n + 1);
    window.addEventListener(SOUND_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(SOUND_SETTINGS_EVENT, sync);
  }, []);

  useEffect(() => {
    const selfId = snapshot?.room.selfId;
    if (selfId) window.localStorage.setItem(LS_PID, selfId);
  }, [snapshot]);

  const onPickCard = (index: number) => {
    primeAudioPlayback();
    if (!snapshot || snapshot.room.phase !== "passing") return;
    if (snapshot.room.selfId !== snapshot.room.currentTurnPlayerId) return;
    socketRef.current?.emit("pass_card", { cardIndex: index });
  };

  const onClaimRank = () => {
    primeAudioPlayback();
    socketRef.current?.emit("show_claim");
  };

  const onPlayAgain = () => {
    primeAudioPlayback();
    socketRef.current?.emit("play_again");
  };
  const onStartGameNow = () => {
    primeAudioPlayback();
    socketRef.current?.emit("start_game");
  };
  const copyInviteLink = useCallback(() => {
    primeAudioPlayback();
    void navigator.clipboard?.writeText(window.location.href);
  }, []);

  const playerCount = snapshot?.room.players.length ?? 0;
  const leaderboard = snapshot?.leaderboard ?? [];

  const isMyTurn =
    !!snapshot &&
    snapshot.room.phase === "passing" &&
    !!snapshot.room.selfId &&
    snapshot.room.selfId === snapshot.room.currentTurnPlayerId;

  const activeTurnPlayer = useMemo(() => {
    if (!snapshot?.room.currentTurnPlayerId) return null;
    return snapshot.room.players.find((p) => p.id === snapshot.room.currentTurnPlayerId) ?? null;
  }, [snapshot]);

  const passTargetName = useMemo(() => {
    if (!snapshot?.room.selfId || snapshot.room.players.length < 2 || !isMyTurn) return null;
    const seats = snapshot.room.players;
    const i = seats.findIndex((p) => p.id === snapshot.room.selfId);
    if (i < 0) return null;
    return seats[(i + 1) % seats.length]?.name ?? null;
  }, [snapshot, isMyTurn]);

  const needsMorePlayers =
    playerCount < 4 &&
    snapshot &&
    (snapshot.room.phase === "countdown" || snapshot.room.phase === "waiting");

  const isPlaying = snapshot?.room.phase === "passing";

  const playAgainQuorum = snapshot?.room.playAgainQuorum ?? 4;
  const playAgainCount = snapshot?.room.playAgainIds?.length ?? 0;
  const soundOn = getEffectiveSoundLevel() > 0;

  const sessionGamesCompleted = snapshot?.room.sessionGamesCompleted ?? 0;
  const sessionPlayersAtLock = snapshot?.room.sessionPlayersAtLock ?? null;
  const rosterLocked = sessionPlayersAtLock != null;

  return (
    <div className={`app ${isPlaying ? "app--playing" : ""}`}>
      {/* ── full-screen flash: CARD SHOW / SHOW ── */}
      {flashOverlay && (
        <div className="flash flash--show" role="alert" aria-live="assertive">
          <div className="flash-inner">
            <h2 className="flash-title">{flashOverlay.title}</h2>
            <p className="flash-body">{flashOverlay.body}</p>
          </div>
        </div>
      )}

      {/* ── session dashboard (always visible: join, lobby, in-game, game over) ── */}
      <section className="session-dash" aria-label="Session dashboard">
        <div className="session-dash-header">
          <span className="session-dash-label">Session</span>
          {joined && !snapshot ? (
            <span className="session-dash-preview">Connecting…</span>
          ) : joined && snapshot ? (
            <>
              <span className="session-dash-room" title="Room phrase">
                {roomName}
              </span>
              <span className="session-dash-div" aria-hidden="true">
                ·
              </span>
              <span className="session-dash-stat">
                Roster:{" "}
                <strong>
                  {rosterLocked
                    ? `${sessionPlayersAtLock} player${sessionPlayersAtLock !== 1 ? "s" : ""} (locked)`
                    : `${playerCount} in lobby — locks at first deal`}
                </strong>
              </span>
              <span className="session-dash-div" aria-hidden="true">
                ·
              </span>
              <span className="session-dash-stat">
                Games finished: <strong>{sessionGamesCompleted}</strong>
              </span>
            </>
          ) : !joined ? (
            <span className="session-dash-preview">
              Join a room to see roster size and how many games your group has finished. Extra players?{" "}
              <strong>Use a new room phrase</strong> — sessions already in progress stay closed.
            </span>
          ) : null}
        </div>
      </section>

      {/* ── deploy error banner ── */}
      {/* Sound — visible after entering arena; unlocking happens on that tap */}
      {joined && (
        <div className="sound-bar" aria-label="Sound controls">
          <span className={`sound-status ${soundOn ? "on" : "off"}`}>{soundOn ? "Sound on" : "Muted"}</span>
          <label className="sound-mute">
            <input
              type="checkbox"
              checked={getSoundMuted()}
              onChange={(e) => setSoundMuted(e.target.checked)}
            />
            Mute
          </label>
          <label className="sound-slider-wrap">
            Vol
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(getSoundVolume() * 100)}
              onChange={(e) => setSoundVolume(Number(e.target.value) / 100)}
              aria-valuetext={`${Math.round(getSoundVolume() * 100)} percent`}
            />
          </label>
          <button type="button" className="sound-prime" onClick={() => primeAudioPlayback()}>
            Enable audio
          </button>
          <span className="sound-bgm-hint" title="Background loop uses half of your volume slider">
            Table music ×½
          </span>
        </div>
      )}

      {MISSING_REALTIME && (
        <div role="alert" className="panel deploy-error">
          <strong>Realtime server not configured.</strong>
          <p className="meta" style={{ marginBottom: 0 }}>
            Add <code>VITE_SOCKET_URL</code> in Vercel pointing to your Node API (e.g.{" "}
            <code>https://showgame-api.onrender.com</code>). Redeploy after saving.
          </p>
        </div>
      )}

      {/* ══════════════════ JOIN SCREEN ══════════════════ */}
      {!joined && (
        <>
          <header>
            <h1>SHOW</h1>
            <p className="sub">Marvel card arena — collect four matching hero cards and call SHOW.</p>
          </header>
          <section className="panel">
            <div className="row">
              <label>
                Your name
                <input value={name} placeholder="Ada" onChange={(e) => setName(e.target.value)} autoCapitalize="words" />
              </label>
              <label>
                Room phrase
                <input value={roomName} placeholder="sunday-snacks" onChange={(e) => setRoomName(e.target.value)} />
              </label>
              <button className="primary" type="button" disabled={name.trim().length === 0 || MISSING_REALTIME} onClick={join}>
                Enter arena
              </button>
            </div>
            {error && <p className="error">{error}</p>}
            <p className="meta" style={{ marginTop: 16 }}>
              Cards: {CARD_LIST_BLURB}
              &nbsp;·&nbsp;minimum <strong>4 players</strong> · max 10 · one room phrase = one session; add new people with a <strong>new</strong> room name.
            </p>
          </section>
        </>
      )}

      {/* ══════════════════ LOBBY (countdown / waiting) ══════════════════ */}
      {joined && snapshot && !isPlaying && snapshot.room.phase !== "game_over" && (
        <>
          <header>
            <h1>SHOW</h1>
          </header>
          <section className="panel">
            <div className="lobby-room">Room: <strong>{roomName}</strong></div>

            {snapshot.room.phase === "countdown" && lobbyMs !== null && (
              <div className="countdown-banner">
                {playerCount < 4 ? (
                  <>Waiting for players — <strong>{playerCount}/4</strong> here · {formatRemaining(lobbyMs)} left</>
                ) : (
                  <>Starting in <strong>{formatRemaining(lobbyMs)}</strong> — or tap Start now</>
                )}
              </div>
            )}

            {needsMorePlayers && (
              <div className="solo-callout">
                <div className="solo-callout-title">Need {4 - playerCount} more player{4 - playerCount !== 1 ? "s" : ""}</div>
                <p className="solo-callout-lead">Share the room phrase <strong>"{roomName}"</strong> or:</p>
                <button type="button" className="primary solo-copy-btn" onClick={copyInviteLink}>
                  Copy invite link
                </button>
              </div>
            )}

            {(snapshot.room.phase === "countdown" || snapshot.room.phase === "waiting") && playerCount >= 4 && (
              <div style={{ marginTop: 14 }}>
                <button type="button" className="primary" onClick={onStartGameNow}>Start game now</button>
              </div>
            )}

            <div className="players" style={{ marginTop: 16 }}>
              {snapshot.room.players.map((p, idx) => (
                <div key={p.id} className={`pill ${p.id === snapshot.room.selfId ? "you" : ""}`}>
                  {p.seat ?? idx + 1}. {p.name}
                </div>
              ))}
            </div>

            {error && <p className="error">{error}</p>}
          </section>
        </>
      )}

      {/* ══════════════════ GAME SCREEN (passing) ══════════════════ */}
      {joined && snapshot && isPlaying && (
        <div className="game-screen">
          {/* top bar: room · round · timer */}
          <div className="game-topbar">
            <span className="game-topbar-room">{roomName}</span>
            <span className="game-topbar-round">Round {snapshot.room.round}</span>
            {passMs !== null && (
              <span className={`game-topbar-timer ${passMs < 4000 ? "urgent" : ""}`}>
                {formatRemaining(passMs)}
              </span>
            )}
          </div>

          {/* turn indicator: all players in a strip */}
          <div className="turn-strip" role="list">
            {snapshot.room.players.map((p, idx) => {
              const isActive = p.id === snapshot.room.currentTurnPlayerId;
              const isMe = p.id === snapshot.room.selfId;
              return (
                <div
                  key={p.id}
                  role="listitem"
                  className={`turn-seat${isActive ? " turn-seat--active" : ""}${isMe ? " turn-seat--me" : ""}`}
                >
                  <span className="turn-seat-num">{p.seat ?? idx + 1}</span>
                  <span className="turn-seat-name">{p.name}</span>
                  {isActive && <span className="turn-seat-arrow" aria-label="passing">▶</span>}
                </div>
              );
            })}
          </div>

          {/* whose turn label */}
          <div className={`whose-turn ${isMyTurn ? "whose-turn--me" : ""}`} role="status" aria-live="polite">
            {isMyTurn
              ? <>Your turn — tap a card to pass to <strong>{passTargetName ?? "next"}</strong></>
              : <><strong>{activeTurnPlayer?.name ?? "…"}</strong> is choosing a card to pass…</>}
          </div>

          {/* 5-card hand */}
          <div className={`hand5 ${isMyTurn ? "hand5--active" : "hand5--waiting"}`}>
            {Array.from({ length: 5 }).map((_, slot) => {
              const card = snapshot.myHand[slot];
              if (card) {
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={`card5 card5--${slugForCardFace(card.name)} ${isMyTurn ? "card5--tappable" : ""}`}
                    disabled={!isMyTurn}
                    onClick={() => onPickCard(slot)}
                    aria-label={isMyTurn ? `Pass ${card.name}` : card.name}
                  >
                    <span className="card5-name">{labelForCardFace(card.name)}</span>
                    {isMyTurn && <span className="card5-hint">tap to pass</span>}
                  </button>
                );
              }
              return <div key={`empty-${slot}`} className="card5 card5--empty" aria-hidden="true" />;
            })}
          </div>
        </div>
      )}

      {/* ══════════════════ GAME OVER ══════════════════ */}
      {joined && snapshot && snapshot.room.phase === "game_over" && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ margin: "0 0 16px", fontSize: "1.4rem" }}>Game over</h2>

          {leaderboard.length > 0 && (
            <div className="leader-grid">
              {leaderboard.map((row) => (
                <div key={row.playerId + row.rank} className="leader-row">
                  <span><span className="badge-rank">{row.rank}.</span> {row.name}</span>
                  <span>₹ {row.prize.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          <button type="button" className="primary" style={{ marginTop: 20 }} onClick={onPlayAgain}>
            Play again
          </button>
          <p className="meta" style={{ marginTop: 10 }}>
            Ready: <strong>{playAgainCount}</strong> / <strong>{playAgainQuorum}</strong> — everyone here must tap Play Again. New friends need a <strong>new room phrase</strong> (see Session bar).
          </p>

          <p className="meta" style={{ marginTop: 14 }}>
            Winner was announced automatically. Tap below only to record your place in the prize order:
          </p>
          <button type="button" className="ghost-btn" onClick={onClaimRank}>
            Claim my prize place
          </button>
        </div>
      )}

      {/* Fixed bottom: invite only (SHOW is automatic + flash + sounds) */}
      {joined && snapshot && (
        <div className="bottom-strip">
          <button type="button" onClick={copyInviteLink}>
            Invite
          </button>
        </div>
      )}
    </div>
  );
}
