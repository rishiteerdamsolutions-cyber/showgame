import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { playCardShow, playShow, resumeAudio } from "./audio.ts";

type CardModel = { id: string; name: string };

type RoomPayload = {
  phase: string;
  countdownEndsAt: number | null;
  passDeadlineAt: number | null;
  players: { id: string; name: string }[];
  selfId?: string;
  round: number;
  starterIndex: number;
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

const SOCKET_URL = import.meta.env.DEV ? "http://127.0.0.1:3001" : "";

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
  const socketRef = useRef(
    SOCKET_URL !== ""
      ? io(SOCKET_URL, { transports: ["websocket"], path: "/socket.io" })
      : io({ transports: ["websocket"], path: "/socket.io", autoConnect: true }),
  );

  const [name, setName] = useState(() => window.localStorage.getItem(LS_NAME) ?? "");
  const [roomName, setRoomName] = useState(
    () => window.localStorage.getItem(LS_ROOM) ?? "family-evening",
  );
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<ServerState | null>(null);

  const [flashCardShow, setFlashCardShow] = useState(false);
  const [flashShow, setFlashShow] = useState(false);
  const flashKeyRef = useRef<string | null>(null);

  const [waitingPass, setWaitingPass] = useState(false);
  const lastRoundRef = useRef<number>(0);

  useEffect(() => {
    window.localStorage.setItem(LS_NAME, name);
  }, [name]);

  useEffect(() => {
    window.localStorage.setItem(LS_ROOM, roomName);
  }, [roomName]);

  useEffect(() => {
    const s = socketRef.current;

    const onState = (p: ServerState) => {
      setSnapshot(p);
      if (lastRoundRef.current !== p.room.round) {
        setWaitingPass(false);
        lastRoundRef.current = p.room.round;
      }
    };

    const onErr = (msg: string) => setError(msg);

    s.on("state", onState);
    s.on("error_msg", onErr);

    return () => {
      s.off("state", onState);
      s.off("error_msg", onErr);
      s.disconnect();
    };
  }, []);

  /** Drive full-screen CARD SHOW / SHOW announcements + audio precisely once each time the server notifies. */
  useEffect(() => {
    const ev = snapshot?.room.lastEvent;
    if (!ev) return;
    const k = `${ev.type}-${ev.at}-${ev.playerId ?? ""}-${ev.name ?? ""}`;
    if (flashKeyRef.current === k) return;
    flashKeyRef.current = k;

    void resumeAudio();
    if (ev.type === "card_show") {
      setFlashCardShow(true);
      playCardShow();
      window.setTimeout(() => setFlashCardShow(false), 1000);
    } else if (ev.type === "show") {
      setFlashShow(true);
      playShow();
      window.setTimeout(() => setFlashShow(false), 2600);
    }
  }, [snapshot]);

  const lobbyMs = useMemo(() => {
    if (!snapshot?.room.countdownEndsAt || snapshot.room.phase !== "countdown") {
      return null;
    }
    return snapshot.room.countdownEndsAt - Date.now();
  }, [snapshot]);

  const passMs = useMemo(() => {
    if (!snapshot?.room.passDeadlineAt || snapshot.room.phase !== "passing") {
      return null;
    }
    return snapshot.room.passDeadlineAt - Date.now();
  }, [snapshot]);

  /** Live countdown ticking */
  const [, bump] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => bump((x) => x + 1), 480);
    return () => window.clearInterval(t);
  }, []);

  const join = useCallback(() => {
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
    socketRef.current.emit("pass_card", { cardIndex: index });
    setWaitingPass(true);
  };

  const onShowTap = async () => {
    await resumeAudio();
    socketRef.current.emit("show_claim");
  };

  const onPlayAgain = () => {
    socketRef.current.emit("play_again");
  };

  const leaderboard = snapshot?.leaderboard ?? [];

  return (
    <div className="app">
      {(flashCardShow || flashShow) && (
        <div className={`flash ${flashCardShow ? "card-show" : ""}`}>
          <div className="flash-inner">
            <h2>{flashCardShow ? "CARD SHOW" : "SHOW"}</h2>
            <p style={{ opacity: 0.8, marginTop: 12 }}>
              {flashCardShow
                ? "Someone is one card away from four of a kind — stay sharp."
                : "We have a full family SHOW — congratulations to the caller."}
            </p>
          </div>
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
              disabled={name.trim().length === 0}
              onClick={join}
            >
              Enter arena
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          <p className="meta" style={{ marginTop: 16 }}>
            Card faces use only RAMA, SITA, LAKSHMAN, HANUMAN, HE-MAN, SUPERMAN, JAMBA, VAALI, RAVAN, and JETAYU
            · each seated player gets four copies of one of those · your table name above is only for scoring and
            the lobby · max ten players · two minutes lobby after the first person arrives · same room phrase reunites
            tables.
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
                Family gate opens automatically in&nbsp;
                <span>{formatRemaining(lobbyMs)}</span>
              </div>
            )}
            {(snapshot.room.phase === "waiting" || snapshot.room.phase === "game_over") && (
              <p className="meta">
                {snapshot.room.phase === "waiting"
                  ? "Waiting for enough family members to gather — share the phrase from your browser bar."
                  : "Hands are closed — leaderboard is final for this SHOW."}
              </p>
            )}
            {(snapshot.room.phase === "passing" || snapshot.room.phase === "countdown") && (
              <p className="meta">
                Round&nbsp;
                <strong>{snapshot.room.round}</strong>
                · passes move clockwise · tap a tile to tuck that strip into the neighbour on your left in the
                table order above.
              </p>
            )}
            {snapshot.room.phase === "passing" && passMs !== null && (
              <div className="meta">
                Passing window resets in <strong>{formatRemaining(passMs)}</strong>.
                {waitingPass && " Waiting for cousins who have not tapped yet..."}
              </div>
            )}
          </section>

          <section className="panel">
            <h2 style={{ marginTop: 0, fontSize: "1.2rem" }}>Table</h2>
            <div className="players">
              {snapshot.room.players.map((p) => (
                <div
                  key={p.id}
                  className={`pill ${p.id === snapshot.room.selfId ? "you" : ""}`}
                >
                  {p.name}
                  {p.id === snapshot.room.players[snapshot.room.starterIndex]?.id
                    ? " · deals first card"
                    : ""}
                </div>
              ))}
            </div>

            <h3 style={{ marginBottom: 4, fontSize: "1rem" }}>Your hand</h3>

            {(snapshot.room.phase === "passing" || snapshot.room.phase === "countdown") && (
              <div className="hand">
                {snapshot.myHand.map((c, idx) => (
                  <button
                    type="button"
                    key={c.id}
                    className="card"
                    disabled={snapshot.room.phase !== "passing"}
                    onClick={() => onPickCard(idx)}
                  >
                    {c.name}
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
                Invite everyone who wants another scramble — as soon as at least two people tap Play Again we
                start a fresh two-minute countdown with only brave returners seeded in.
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
            <button type="button" onClick={() => navigator.clipboard?.writeText(window.location.href)}>
              Copy invite link
            </button>
          </div>
        </>
      )}
    </div>
  );
}
