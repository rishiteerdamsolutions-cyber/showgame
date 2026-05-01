import http from "node:http";
import path from "node:path";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { assertConfiguredNames } from "./names.ts";
import { GameRoom, normalizeRoom } from "./gameRoom.ts";

assertConfiguredNames();

const PORT = Number(process.env.PORT ?? 3001);
const STATIC_DIR =
  process.env.NODE_ENV === "production"
    ? path.join(process.cwd(), "dist", "client")
    : "";

const rooms = new Map<string, GameRoom>();

function roomFor(nameDisplay: string): GameRoom {
  const key = normalizeRoom(nameDisplay);
  let r = rooms.get(key);
  if (!r) {
    r = new GameRoom(nameDisplay);
    rooms.set(key, r);
  }
  return r;
}

export function broadcastRoom(room: GameRoom, io: Server): void {
  for (const s of room.seats) {
    if (!s.socketId) continue;
    io.to(s.socketId).emit("state", buildPayload(room, s.id));
  }
}

function leaderboard(room: GameRoom): { rank: number; playerId: string; name: string; prize: number }[] {
  if (!room.winnerId || room.phase !== "game_over") return [];
  const n = Math.max(room.seats.length, 1);
  const rows: { rank: number; playerId: string; name: string; prize: number }[] = [];

  rows.push({
    rank: 1,
    playerId: room.winnerId,
    name: room.seats.find((s) => s.id === room.winnerId)?.name ?? "?",
    prize: GameRoom.prize(1, n),
  });

  room.showClickOrder.forEach((pid, idx) => {
    const name = room.seats.find((s) => s.id === pid)?.name ?? "?";
    rows.push({
      rank: idx + 2,
      playerId: pid,
      name,
      prize: GameRoom.prize(idx + 2, n),
    });
  });
  return rows;
}

export function buildPayload(room: GameRoom, forPlayerId?: string): object {
  const seat = room.seats.find((p) => p.id === forPlayerId);
  return {
    room: room.snapshotFor(forPlayerId),
    myHand: seat ? seat.hand.map((c) => ({ ...c })) : [],
    leaderboard: leaderboard(room),
    generation: room.generation,
  };
}

function setupTimers(io: Server): void {
  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const evt = room.tick(now);
      if (evt !== "none") {
        broadcastRoom(room, io);
      }
    }
  }, 750);
}

async function bootstrap(): Promise<void> {
  const app = express();

  app.use(
    cors({
      origin:
        process.env.NODE_ENV === "production"
          ? true
          : ["http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: true,
    }),
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  if (STATIC_DIR && process.env.NODE_ENV === "production") {
    app.use(express.static(STATIC_DIR));
    app.get("*", (_req, res) =>
      res.sendFile(path.join(STATIC_DIR, "index.html")),
    );
  }

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin:
        process.env.NODE_ENV === "production"
          ? true
          : ["http://localhost:5173", "http://127.0.0.1:5173"],
    },
  });

  setupTimers(io);

  io.on("connection", (socket) => {
    socket.on(
      "join",
      ({
        roomName,
        playerName,
        playerId,
      }: {
        roomName: string;
        playerName: string;
        playerId?: string;
      }) => {
        try {
          const room = roomFor(roomName);
          const key = room.nameNormalized;
          socket.join(`arena:${key}`); // retained for optional future spectator hooks

          let seat = playerId ? room.reconnectSeat(playerId, socket.id) : undefined;
          if (!seat) seat = room.addPlayer(socket.id, playerName);

          socket.data.roomKey = key;
          socket.data.playerId = seat.id;

          broadcastRoom(room, io);
        } catch (e) {
          socket.emit(
            "error_msg",
            e instanceof Error ? e.message : "Unable to join room",
          );
        }
      },
    );

    socket.on("pass_card", ({ cardIndex }: { cardIndex: number }) => {
      const key = socket.data.roomKey as string | undefined;
      const playerId = socket.data.playerId as string | undefined;
      if (!key || playerId === undefined) return;
      const room = rooms.get(key);
      if (!room) return;
      room.submitPass(playerId, cardIndex);
      broadcastRoom(room, io);
    });

    socket.on("show_claim", () => {
      const key = socket.data.roomKey as string | undefined;
      const playerId = socket.data.playerId as string | undefined;
      if (!key || !playerId) return;
      const room = rooms.get(key);
      if (!room) return;
      room.registerShowClaim(playerId);
      broadcastRoom(room, io);
    });

    socket.on("play_again", () => {
      const key = socket.data.roomKey as string | undefined;
      const playerId = socket.data.playerId as string | undefined;
      if (!key || !playerId) return;
      const room = rooms.get(key);
      if (!room) return;
      room.requestPlayAgain(playerId);
      broadcastRoom(room, io);
    });

    socket.on("disconnect", () => {
      const key = socket.data.roomKey as string | undefined;
      if (!key) return;
      const room = rooms.get(key);
      if (!room) return;
      room.removeSocket(socket.id);
      broadcastRoom(room, io);
    });
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console -- helpful for family testing
    console.log(`SHOW game server on http://localhost:${PORT}`);
  });
}

bootstrap().catch(console.error);
