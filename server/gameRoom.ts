import { FAMILY_CARD_NAMES } from "./names";

export type Card = { id: string; name: string };

export type PlayerSeat = {
  id: string;
  name: string;
  socketId: string | null;
  hand: Card[];
};

export type GamePhase =
  | "waiting"
  | "countdown"
  | "passing"
  | "game_over";

export interface RoomSnapshot {
  name: string;
  phase: GamePhase;
  countdownEndsAt: number | null;
  passDeadlineAt: number | null;
  /** Seats 1…n in join order; pass goes to the next seat (1→2→…→n→1). */
  players: { id: string; name: string; seat: number }[];
  selfId?: string;
  round: number;
  starterIndex: number;
  /** Who must tap a card this moment (sequential pass). */
  currentTurnPlayerId: string | null;
  lastEvent?: {
    type: "card_show" | "show";
    playerId?: string;
    name?: string;
    at: number;
  };
  winnerId?: string;
  playAgainIds: string[];
}

const LOBBY_MS = 2 * 60 * 1000;
const MIN_PLAYERS = 4;
/** Time each player has to pick a card to pass each round. */
const PASS_MS = 10 * 1000;

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function newId(): string {
  return crypto.randomUUID();
}

function countByName(cards: Card[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cards) m.set(c.name, (m.get(c.name) ?? 0) + 1);
  return m;
}

/**
 * From exactly 4 cards — classify win / CARD_SHOW (triple) / pair trim.
 * When applied in play, CARD_SHOW only broadcasts; it does not remove cards from the hand.
 */
export function resolveFourCardHand(cards: Card[]): {
  outcome: "win" | "card_show" | "trim";
  hand: Card[];
  winningName?: string;
  cardShowName?: string;
} {
  if (cards.length !== 4) {
    throw new Error("resolveFourCardHand expects 4 cards");
  }
  const entries = [...countByName(cards).entries()].sort((a, b) => b[1] - a[1]);
  const [topName, topN] = entries[0]!;

  if (topN === 4) {
    return { outcome: "win", hand: cards, winningName: topName };
  }
  if (topN === 3) {
    const keep = cards.filter((c) => c.name === topName);
    return { outcome: "card_show", hand: keep, cardShowName: topName };
  }
  if (topN === 2) {
    const pairName = topName;
    const others = cards.filter((c) => c.name !== pairName);
    if (others.length === 2) {
      if (others[0]!.name === others[1]!.name) {
        const pairNames = [...new Set([pairName, others[0]!.name])].sort((a, b) =>
          a.localeCompare(b),
        );
        const dropName = pairNames[1]!;
        const drop = cards.find((c) => c.name === dropName)!;
        const hand = cards.filter((c) => c.id !== drop.id);
        return { outcome: "trim", hand };
      }
      const sortedOthers = [...others].sort((a, b) => a.name.localeCompare(b.name));
      const discard = sortedOthers[0]!;
      const hand = cards.filter((c) => c.id !== discard.id);
      return { outcome: "trim", hand };
    }
  }
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  const discard = sorted[0]!;
  const hand = cards.filter((c) => c.id !== discard.id);
  return { outcome: "trim", hand };
}

/**
 * From exactly five cards — e.g. triple + duplicate pair before trimming.
 */
function resolveFiveCardHand(cards: Card[]): {
  outcome: "win" | "to_four";
  hand: Card[];
  winningName?: string;
} {
  const entries = [...countByName(cards).entries()].sort((a, b) => b[1] - a[1]);
  const [topName, topN] = entries[0]!;

  if (topN === 4) {
    const stray = cards.find((c) => c.name !== topName)!;
    const keepFour = cards.filter((c) => c.id !== stray.id).slice(0, 4);
    return { outcome: "win", hand: keepFour, winningName: topName };
  }

  if (topN === 3 && entries[1]?.[1] === 2) {
    const pairName = entries[1]![0];
    const drop = cards.find((c) => c.name === pairName)!;
    return {
      outcome: "to_four",
      hand: cards.filter((c) => c.id !== drop.id),
    };
  }

  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  const discard = sorted[0]!;
  return {
    outcome: "to_four",
    hand: cards.filter((c) => c.id !== discard.id),
  };
}

function buildDeck(nPlayers: number, rng: () => number): Card[] {
  if (nPlayers > FAMILY_CARD_NAMES.length) {
    throw new Error("Too many players for configured names list.");
  }
  const chosen = shuffle([...FAMILY_CARD_NAMES], rng).slice(0, nPlayers);
  const deck: Card[] = [];
  for (const name of chosen) {
    for (let k = 0; k < 4; k++) {
      deck.push({ id: newId(), name });
    }
  }
  return shuffle(deck, rng);
}

export class GameRoom {
  readonly nameNormalized: string;
  private rngSeed: number;

  seats: PlayerSeat[] = [];
  phase: GamePhase = "waiting";
  round = 0;
  starterIndex = 0;
  countdownEndsAt: number | null = null;

  /** Whose turn it is to pass one card (receiver becomes active next). */
  currentTurnPlayerId: string | null = null;

  /** Counts each pass since deal (for full-table wave → bump round). */
  passSinceDeal = 0;

  showClickOrder: string[] = [];

  winnerId?: string;
  winnerName?: string;

  playAgainIds = new Set<string>();

  passDeadlineAt: number | null = null;

  generation = 1;

  lastBroadcast: RoomSnapshot["lastEvent"];

  constructor(roomDisplayName: string) {
    this.nameNormalized = normalizeRoom(roomDisplayName);
    this.rngSeed = (Math.random() * 0xffffffff) >>> 0;
  }

  addPlayer(socketId: string, displayName: string): PlayerSeat {
    const id = newId();
    const seat: PlayerSeat = {
      id,
      name: displayName.trim().slice(0, 48) || "Player",
      socketId,
      hand: [],
    };
    if (this.seats.length >= 10) {
      throw new Error("Room is full (max 10).");
    }
    const before = this.seats.length;
    this.seats.push(seat);

    if (before === 0 && this.phase === "waiting") {
      // Two minutes from the moment the first person enters the arena.
      this.countdownEndsAt = Date.now() + LOBBY_MS;
      this.phase = "countdown";
    } else if (
      this.phase === "waiting" &&
      !this.countdownEndsAt &&
      this.seats.length >= 1
    ) {
      // Lobby timer ended with only one player (or resumed) — start again when folks return.
      this.countdownEndsAt = Date.now() + LOBBY_MS;
      this.phase = "countdown";
    }

    return seat;
  }

  reconnectSeat(playerId: string, socketId: string): PlayerSeat | undefined {
    const p = this.seats.find((s) => s.id === playerId);
    if (p) p.socketId = socketId;
    return p;
  }

  attachSocket(playerId: string, socketId: string): PlayerSeat | undefined {
    return this.reconnectSeat(playerId, socketId);
  }

  requestPlayAgain(playerId: string): boolean {
    if (this.phase !== "game_over") return false;
    this.playAgainIds.add(playerId);
    if (this.playAgainIds.size >= MIN_PLAYERS) {
      return this.startNextMatchIfReady();
    }
    return false;
  }

  startNextMatchIfReady(): boolean {
    if (this.phase !== "game_over") return false;
    const active = this.seats.filter((s) => this.playAgainIds.has(s.id));
    if (active.length < MIN_PLAYERS) return false;

    this.seats = active.map((s) => ({
      ...s,
      socketId: s.socketId,
      hand: [],
    }));
    this.playAgainIds.clear();
    this.winnerId = undefined;
    this.winnerName = undefined;
    this.showClickOrder = [];
    this.round = 0;
    this.currentTurnPlayerId = null;
    this.passSinceDeal = 0;
    this.lastBroadcast = undefined;
    this.generation += 1;
    this.rngSeed = (Math.random() * 0xffffffff) >>> 0;
    // Next lobby: first opt-in resets the countdown when they tap — require one opt-in gate:
    this.countdownEndsAt = Date.now() + LOBBY_MS;
    this.phase = "countdown";
    return true;
  }

  removeSocket(socketId: string): void {
    const p = this.seats.find((s) => s.socketId === socketId);
    if (p) p.socketId = null;
  }

  /**
   * Any seated player may skip the lobby timer once at least four players are at the table.
   * If nobody taps start, `tick()` still auto-deals when the two-minute window ends.
   */
  requestStartGame(playerId: string): boolean {
    const okPhase = this.phase === "countdown" || this.phase === "waiting";
    if (!okPhase) return false;
    if (this.seats.length < MIN_PLAYERS) return false;
    if (!this.seats.some((s) => s.id === playerId)) return false;
    this.countdownEndsAt = null;
    this.dealAndBegin();
    return true;
  }

  tick(now: number): "started" | "pass_round" | "none" {
    if (
      this.phase === "countdown" &&
      this.countdownEndsAt &&
      now >= this.countdownEndsAt
    ) {
      this.countdownEndsAt = null;
      if (this.seats.length >= MIN_PLAYERS) {
        this.dealAndBegin();
        return "started";
      }
      // Not enough players — stay in lobby until the next countdown is started when someone joins again.
      this.phase = "waiting";
      return "none";
    }

    if (
      this.phase === "passing" &&
      this.passDeadlineAt &&
      now >= this.passDeadlineAt &&
      this.currentTurnPlayerId
    ) {
      const seat = this.seats.find((s) => s.id === this.currentTurnPlayerId);
      if (seat && seat.hand.length > 0) {
        const rightMost = seat.hand.length - 1;
        this.executePass(seat.id, rightMost);
      } else {
        // Avoid spinning every tick if turn state is inconsistent (should not happen in normal play).
        this.passDeadlineAt = Date.now() + PASS_MS;
      }
      return "pass_round";
    }

    return "none";
  }

  submitPass(playerId: string, cardIndex: number): boolean {
    if (this.phase !== "passing") return false;
    if (playerId !== this.currentTurnPlayerId) return false;
    const seat = this.seats.find((s) => s.id === playerId);
    if (!seat) return false;
    if (cardIndex < 0 || cardIndex >= seat.hand.length) return false;
    this.executePass(playerId, cardIndex);
    return true;
  }

  registerShowClaim(playerId: string): number | undefined {
    if (this.phase !== "game_over" || !this.winnerId) return undefined;
    if (playerId === this.winnerId) return 1;
    const existing = this.showClickOrder.indexOf(playerId);
    if (existing !== -1) return existing + 2;
    this.showClickOrder.push(playerId);
    return this.showClickOrder.length + 1;
  }

  private dealAndBegin(): void {
    const rng = makeRng(this.rngSeed);
    const n = this.seats.length;
    const deck = buildDeck(n, rng);
    for (let i = 0; i < n; i++) {
      this.seats[i]!.hand = deck.slice(i * 4, i * 4 + 4);
    }
    this.starterIndex = Math.floor(rng() * n);
    this.round = 1;
    this.phase = "passing";
    this.passSinceDeal = 0;
    this.currentTurnPlayerId = this.seats[this.starterIndex]!.id;
    this.passDeadlineAt = Date.now() + PASS_MS;
  }

  /**
   * Pass one card from sender to the next seat (seat 1→2→…→n→1). Receiver always acts next.
   * Timeout uses rightmost card index (hand[length-1]).
   */
  private executePass(senderId: string, cardIndex: number): void {
    if (this.phase !== "passing" || senderId !== this.currentTurnPlayerId) return;

    const si = this.seats.findIndex((s) => s.id === senderId);
    if (si < 0) return;
    const n = this.seats.length;
    const sender = this.seats[si]!;
    const ri = (si + 1) % n;
    const receiver = this.seats[ri]!;

    if (cardIndex < 0 || cardIndex >= sender.hand.length) return;

    const [card] = sender.hand.splice(cardIndex, 1);
    receiver.hand.push(card);
    this.passSinceDeal++;

    // Five cards: only instant SHOW (four of a kind + stray). Other five-card shapes stay at 5 until that player passes.
    if (receiver.hand.length === 5) {
      const probe = resolveFiveCardHand([...receiver.hand]);
      if (probe.outcome === "win" && probe.winningName) {
        this.endGame(receiver.id, probe.winningName);
        return;
      }
    }

    if (this.applyFourCardRules(sender)) return;
    if (this.applyFourCardRules(receiver)) return;

    this.currentTurnPlayerId = receiver.id;
    this.passDeadlineAt = Date.now() + PASS_MS;

    if (this.passSinceDeal % n === 0 && this.passSinceDeal > 0) {
      this.round++;
    }
  }

  /** @returns true if the game ended (SHOW). */
  private applyFourCardRules(seat: PlayerSeat): boolean {
    if (seat.hand.length !== 4) return false;
    const r = resolveFourCardHand(seat.hand);
    if (r.outcome === "win" && r.winningName) {
      this.endGame(seat.id, r.winningName);
      return true;
    }
    if (r.outcome === "card_show") {
      this.lastBroadcast = {
        type: "card_show",
        playerId: seat.id,
        name: r.cardShowName,
        at: Date.now(),
      };
      // Announce only — do not remove cards; the player still holds all four.
      return false;
    }
    seat.hand = r.hand;
    return false;
  }

  private endGame(winnerSeatId: string, winningCardName: string): void {
    this.winnerId = winnerSeatId;
    this.winnerName = winningCardName;
    for (const s of this.seats) s.hand = [];
    this.phase = "game_over";
    this.currentTurnPlayerId = null;
    this.passDeadlineAt = null;
    this.lastBroadcast = {
      type: "show",
      playerId: winnerSeatId,
      name: winningCardName,
      at: Date.now(),
    };
  }

  static prize(rank: number, playerCount: number): number {
    if (rank > playerCount) return 0;
    const top = playerCount * 1000;
    const p = top - (rank - 1) * 1000;
    return Math.max(p, 0);
  }

  snapshotFor(playerId?: string): RoomSnapshot {
    return {
      name: this.nameNormalized,
      phase: this.phase,
      countdownEndsAt: this.countdownEndsAt,
      passDeadlineAt: this.passDeadlineAt,
      players: this.seats.map((s, i) => ({
        id: s.id,
        name: s.name,
        seat: i + 1,
      })),
      selfId: playerId,
      round: this.round,
      starterIndex: this.starterIndex,
      currentTurnPlayerId: this.currentTurnPlayerId,
      lastEvent: this.lastBroadcast,
      winnerId: this.winnerId,
      playAgainIds: [...this.playAgainIds],
    };
  }
}

export function normalizeRoom(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 48) || "family-room";
}
