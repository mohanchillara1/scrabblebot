// In-memory mirror of the server rows the live bot cares about, plus the
// MatchView builder. No SpacetimeDB SDK dependency: the live glue, the replay
// test and the mock test all feed it the same row shapes (the generated
// bindings' row types, i.e. bigint ids/amounts and { tag } enums).

import type {
  AuctionRecord,
  AuctionType,
  MatchView,
  PlayerPublic,
  SimStrategyTag,
  WordRecord,
} from "../core/types.js";

// ---- row shapes (subset of the generated bindings; extra fields tolerated) ----

export interface Tagged {
  tag: string;
}
export interface TimestampLike {
  microsSinceUnixEpoch: bigint;
}
export interface MatchStateRow {
  id: bigint;
  status: Tagged; // Lobby | Running | Ended
  currentRound: number;
  currentAuctionId?: bigint | undefined;
  bagTotal: number;
  auctionType: Tagged; // Vickrey | FirstPrice
  auctionDurationMs: bigint | number;
  startingRackSize: number;
}
export interface ParticipantRow {
  id?: bigint;
  matchId: bigint;
  botId: bigint;
  balance: bigint | number;
  score: bigint | number;
}
export interface BotRow {
  id: bigint;
  name?: string;
  isSimulated: boolean;
  strategy?: Tagged; // Human | Cheapskate | ValueBidder | Aggressive
}
export interface RackRow {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  letter: string;
  count: number;
}
export interface AuctionRow {
  id: bigint;
  matchId: bigint;
  letter: string;
  opensAt?: TimestampLike;
  closesAt?: TimestampLike;
  status: Tagged; // Open | Closed
}
export interface ResultRow {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  winnerBotId?: bigint | null | undefined;
  paid: bigint | number;
  closedAt?: TimestampLike;
}
export interface WordRow {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  word: string;
  totalReward: bigint | number;
  playedAt?: TimestampLike;
}

// ---- safe numeric conversion ----

/** bigint|number -> number. Saturates (never throws) outside the safe-integer range. */
export function num(v: bigint | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (v < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(v);
}

function micros(t: TimestampLike | undefined): number {
  return t ? num(t.microsSinceUnixEpoch) : 0;
}

const SIM_TAGS: ReadonlySet<string> = new Set(["Cheapskate", "ValueBidder", "Aggressive"]);

// ---- pending (submitted but not yet reflected) word plays ----

export interface PendingWord {
  word: string;
  counts: Map<string, number>;
  reward: number;
  state: "inflight" | "ok" | "failed";
}

export function wordCounts(word: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const ch of word) m.set(ch, (m.get(ch) ?? 0) + 1);
  return m;
}

// ---- the store ----

export class LiveStore {
  matches = new Map<bigint, MatchStateRow>();
  /** matchId -> botId -> row */
  participants = new Map<bigint, Map<bigint, ParticipantRow>>();
  bots = new Map<bigint, BotRow>();
  /** my_rack rows by row id (all matches). */
  rack = new Map<bigint, RackRow>();
  /** matchId -> auctionId -> result */
  results = new Map<bigint, Map<bigint, ResultRow>>();
  /** matchId -> wordPlay id -> row */
  words = new Map<bigint, Map<bigint, WordRow>>();
  auctions = new Map<bigint, AuctionRow>();
  /** matchId -> pending own word plays that the tables may not reflect yet. */
  pending = new Map<bigint, PendingWord[]>();

  constructor(public myBotId: bigint) {}

  clear(): void {
    this.matches.clear();
    this.participants.clear();
    this.bots.clear();
    this.rack.clear();
    this.results.clear();
    this.words.clear();
    this.auctions.clear();
    this.pending.clear();
  }

  upsertMatch(r: MatchStateRow): void {
    this.matches.set(r.id, r);
  }
  upsertParticipant(r: ParticipantRow): void {
    let m = this.participants.get(r.matchId);
    if (!m) this.participants.set(r.matchId, (m = new Map()));
    m.set(r.botId, r);
  }
  removeParticipant(r: ParticipantRow): void {
    this.participants.get(r.matchId)?.delete(r.botId);
  }
  upsertBot(r: BotRow): void {
    this.bots.set(r.id, r);
  }
  upsertRack(r: RackRow): void {
    this.rack.set(r.id, r);
  }
  removeRack(r: RackRow): void {
    this.rack.delete(r.id);
  }
  upsertResult(r: ResultRow): void {
    let m = this.results.get(r.matchId);
    if (!m) this.results.set(r.matchId, (m = new Map()));
    m.set(r.auctionId, r);
  }
  upsertWord(r: WordRow): void {
    let m = this.words.get(r.matchId);
    if (!m) this.words.set(r.matchId, (m = new Map()));
    m.set(r.id, r);
  }
  upsertAuction(r: AuctionRow): void {
    this.auctions.set(r.id, r);
  }

  addPending(matchId: bigint, p: PendingWord): void {
    let l = this.pending.get(matchId);
    if (!l) this.pending.set(matchId, (l = []));
    l.push(p);
  }
  /** Drop a pending word once its reducer call settled (success is already in the cache). */
  dropPending(matchId: bigint, p: PendingWord): void {
    const l = this.pending.get(matchId);
    if (!l) return;
    const i = l.indexOf(p);
    if (i >= 0) l.splice(i, 1);
    if (l.length === 0) this.pending.delete(matchId);
  }

  amIn(matchId: bigint): boolean {
    return this.participants.get(matchId)?.has(this.myBotId) ?? false;
  }

  /** Confirmed rack from my_rack rows (no pending adjustment). */
  tableRack(matchId: bigint): Map<string, number> {
    const rack = new Map<string, number>();
    for (const h of this.rack.values()) {
      if (h.matchId !== matchId || h.botId !== this.myBotId) continue;
      if (h.count <= 0) continue;
      const letter = h.letter.toUpperCase();
      rack.set(letter, (rack.get(letter) ?? 0) + h.count);
    }
    return rack;
  }

  /** Results of a match in auction order (auction ids are monotonic). */
  sortedResults(matchId: bigint): ResultRow[] {
    const m = this.results.get(matchId);
    if (!m) return [];
    return [...m.values()].sort((a, b) => (a.auctionId < b.auctionId ? -1 : a.auctionId > b.auctionId ? 1 : 0));
  }

  /** Round (1-based) of a result inside its match = its rank by auction id. */
  roundOfResult(matchId: bigint, auctionId: bigint): number {
    const rs = this.sortedResults(matchId);
    const i = rs.findIndex((r) => r.auctionId === auctionId);
    return i >= 0 ? i + 1 : rs.length;
  }

  recordOf(matchId: bigint, r: ResultRow): AuctionRecord {
    return {
      round: this.roundOfResult(matchId, r.auctionId),
      letter: r.letter.toUpperCase(),
      winnerBotId: r.winnerBotId === undefined || r.winnerBotId === null ? null : num(r.winnerBotId),
      paid: num(r.paid),
    };
  }

  /**
   * Build the strategy's MatchView from the mirrored rows.
   * `withPending` applies own in-flight word plays optimistically: their letters
   * are treated as spent and their rewards as already credited.
   */
  buildView(matchId: bigint, withPending = true): MatchView | null {
    const ms = this.matches.get(matchId);
    const parts = this.participants.get(matchId);
    if (!ms || !parts) return null;
    const mine = parts.get(this.myBotId);
    if (!mine) return null;

    const rack = this.tableRack(matchId);
    let myBalance = num(mine.balance);
    let myScore = num(mine.score);
    const extraWords: WordRecord[] = [];
    if (withPending) {
      const round = ms.currentRound;
      for (const p of this.pending.get(matchId) ?? []) {
        if (p.state === "failed") continue;
        for (const [ch, n] of p.counts) {
          const left = (rack.get(ch) ?? 0) - n;
          if (left > 0) rack.set(ch, left);
          else rack.delete(ch);
        }
        myBalance += p.reward;
        myScore += p.reward;
        extraWords.push({ round, botId: num(this.myBotId), word: p.word, reward: p.reward });
      }
    }

    const players: PlayerPublic[] = [];
    for (const p of parts.values()) {
      const bot = this.bots.get(p.botId);
      const isMe = p.botId === this.myBotId;
      const pl: PlayerPublic = {
        botId: num(p.botId),
        balance: isMe ? myBalance : num(p.balance),
        score: isMe ? myScore : num(p.score),
        isSim: bot?.isSimulated ?? false,
      };
      const tag = bot?.strategy?.tag;
      if (pl.isSim && tag !== undefined && SIM_TAGS.has(tag)) pl.simStrategy = tag as SimStrategyTag;
      players.push(pl);
    }
    players.sort((a, b) => a.botId - b.botId);

    const results = this.sortedResults(matchId);
    const resultTimes = results.map((r) => micros(r.closedAt));
    const auctionHistory: AuctionRecord[] = results.map((r, i) => ({
      round: i + 1,
      letter: r.letter.toUpperCase(),
      winnerBotId: r.winnerBotId === undefined || r.winnerBotId === null ? null : num(r.winnerBotId),
      paid: num(r.paid),
    }));

    const wm = this.words.get(matchId);
    const wordHistory: WordRecord[] = [];
    if (wm) {
      const rows = [...wm.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const w of rows) {
        // Round of auction N = 1 + number of auctions that closed STRICTLY before it. A sim winner plays in
        // the same transaction as the close of auction N (playedAt == closedAt), so it counts as round N,
        // matching the simulator (src/sim/engine.ts credit(..., round, "sim")).
        const t = micros(w.playedAt);
        let closed = 0;
        for (const ct of resultTimes) if (ct < t) closed++;
        wordHistory.push({
          round: Math.max(1, closed + 1),
          botId: num(w.botId),
          word: w.word.toUpperCase(),
          reward: num(w.totalReward),
        });
      }
    }
    wordHistory.push(...extraWords);

    const auctionType: AuctionType = ms.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey";
    return {
      matchId: num(matchId),
      myBotId: num(this.myBotId),
      auctionType,
      auctionDurationMs: num(ms.auctionDurationMs),
      startingRackSize: ms.startingRackSize,
      players,
      myRack: rack,
      myBalance,
      myScore,
      round: ms.currentRound,
      bagRemaining: ms.bagTotal,
      auctionHistory,
      wordHistory,
    };
  }
}
