// LiveBot: the SDK-independent core of the live client. Feed it table rows
// (onMatchState/onParticipant/onRack/onResult/onWord/onAuction/onBot) and it
// drives a Strategy through the auction -> words -> bid flow via a Transport.
//
// Per Open auction in a match I'm in:
//   1. strategy.words(view)            (view = confirmed rows)
//   2. submitWord for each, in order   (not awaited: pipelined on one connection)
//   3. strategy.bid(view')             (view' = optimistic: words applied)
//   4. submitBid(min(bid, confirmed balance)) immediately, then, only if the bid
//      exceeds the confirmed balance, submitBid(bid) right behind it. The second
//      call is the in-order optimistic raise: if the server applies one
//      connection's reducers in order it is accepted, otherwise it is rejected
//      with "Insufficient balance" and the capped bid stands. Either way, once
//      the word reducers settle, the final bid is re-checked against the real
//      balance and re-sent if it differs. We never rely on ordering.
//
// Strategy exceptions never escape: they are logged and replaced by a safe
// default (no words / bid 0). On the last auction the leftover rack is always
// dumped with bestPartition (src/engine/words.ts).

import type { Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import {
  LiveStore,
  num,
  wordCounts,
  type AuctionRow,
  type BotRow,
  type MatchStateRow,
  type ParticipantRow,
  type PendingWord,
  type RackRow,
  type ResultRow,
  type WordRow,
} from "./store.js";

export interface Transport {
  submitBid(auctionId: bigint, amount: number): Promise<void>;
  submitWord(matchId: bigint, word: string): Promise<void>;
  joinLobby(): Promise<void>;
  /** Re-read confirmed rack/participant/match rows for a match from the SDK cache into the store. */
  resync?(matchId: bigint): void;
}

export type Logger = (line: string) => void;

export interface BotOptions {
  strategy: Strategy;
  transport: Transport;
  store: LiveStore;
  name?: string;
  log?: Logger;
  /** Milliseconds clock; injectable for tests. */
  now?: () => number;
  /** Defer function used to batch same-transaction callbacks; default setImmediate. */
  defer?: (fn: () => void) => void;
  /** Join the lobby automatically after a match ends / when idle. */
  autoLobby?: boolean;
}

interface MyAuctionLog {
  bid: number;
  balAtBid: number; // our balance (optimistic, after our own word rewards) when the bid was computed
  rackSize: number; // tiles in our rack at bid time (after the words played this auction)
  words: string[];
  bidMs: number; // ms from first sight of the auction to the first submitBid call
  note: string;
}

export interface BotStats {
  auctions: number;
  bidCalls: number;
  bidErrors: number;
  wordCalls: number;
  wordErrors: number;
  strategyErrors: number;
  optimisticAccepted: number;
  optimisticRejected: number;
  lateBids: number;
  bidMs: number[];
  wordsMs: number[];
  bidComputeMs: number[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class LiveBot {
  readonly store: LiveStore;
  readonly strategy: Strategy;
  readonly transport: Transport;
  readonly name: string;
  readonly stats: BotStats = {
    auctions: 0,
    bidCalls: 0,
    bidErrors: 0,
    wordCalls: 0,
    wordErrors: 0,
    strategyErrors: 0,
    optimisticAccepted: 0,
    optimisticRejected: 0,
    lateBids: 0,
    bidMs: [],
    wordsMs: [],
    bidComputeMs: [],
  };

  private log: Logger;
  private now: () => number;
  private defer: (fn: () => void) => void;
  private autoLobby: boolean;

  private started = new Set<bigint>(); // onMatchStart called (survives reconnects)
  private handled = new Set<bigint>(); // auction ids whose words+bid flow ran
  private reported = new Set<bigint>(); // auction ids whose result reached the strategy
  private seenAt = new Map<bigint, number>(); // auction id -> clock when first seen
  private myLog = new Map<bigint, MyAuctionLog>();
  private endedLogged = new Set<bigint>();
  private endedPending = new Set<bigint>(); // matches seen transitioning to Ended while connected
  private dirty = new Set<bigint>();
  private scheduled = false;
  private inflight = new Set<Promise<void>>();
  private lobbyCooldownUntil = 0;
  private lobbyBusy = false;
  private lastDumpLog = new Set<bigint>();

  constructor(opts: BotOptions) {
    this.store = opts.store;
    this.strategy = opts.strategy;
    this.transport = opts.transport;
    this.name = opts.name ?? opts.strategy.name;
    this.log = opts.log ?? ((s) => console.log(s));
    this.now = opts.now ?? (() => performance.now());
    this.defer = opts.defer ?? ((fn) => void setImmediate(fn));
    this.autoLobby = opts.autoLobby ?? true;
  }

  // ---------- ingest (called by the SDK glue / replay / mocks) ----------

  onBot(r: BotRow): void {
    this.store.upsertBot(r);
  }
  onMatchState(r: MatchStateRow): void {
    const old = this.store.matches.get(r.id);
    this.store.upsertMatch(r);
    if (this.store.amIn(r.id)) this.markDirty(r.id);
    if (old && old.status.tag !== "Ended" && r.status.tag === "Ended" && this.store.amIn(r.id)) {
      this.endedPending.add(r.id);
      this.markDirty(r.id);
    }
  }
  onParticipant(r: ParticipantRow): void {
    this.store.upsertParticipant(r);
  }
  onParticipantRemoved(r: ParticipantRow): void {
    this.store.removeParticipant(r);
  }
  onRack(r: RackRow): void {
    this.store.upsertRack(r);
  }
  onRackRemoved(r: RackRow): void {
    this.store.removeRack(r);
  }
  /** Replace my rack rows for a match with a fresh read of the SDK cache. */
  replaceRack(matchId: bigint, rows: RackRow[]): void {
    for (const r of [...this.store.rack.values()]) if (r.matchId === matchId) this.store.removeRack(r);
    for (const r of rows) this.store.upsertRack(r);
  }
  onWord(r: WordRow): void {
    this.store.upsertWord(r);
  }
  onResult(r: ResultRow): void {
    this.store.upsertResult(r);
    this.markDirty(r.matchId);
  }
  onAuction(r: AuctionRow): void {
    this.store.upsertAuction(r);
    if (r.status.tag === "Open" && !this.seenAt.has(r.id)) this.seenAt.set(r.id, this.now());
    this.markDirty(r.matchId);
  }

  /** Forget per-connection state before a reconnect (strategy + started set survive). */
  resetSession(): void {
    this.store.clear();
    this.handled.clear();
    this.seenAt.clear();
    this.dirty.clear();
    this.scheduled = false;
  }

  /** Resolves when everything scheduled so far (including async reducer follow-ups) is done. Tests/replay. */
  async idle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.scheduled) await new Promise<void>((r) => setImmediate(r));
      if (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
      if (!this.scheduled && this.inflight.size === 0 && this.dirty.size === 0) return;
    }
  }

  // ---------- scheduling ----------

  private markDirty(matchId: bigint): void {
    this.dirty.add(matchId);
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => this.runTick());
  }

  private runTick(): void {
    this.scheduled = false;
    const matches = [...this.dirty];
    this.dirty.clear();
    for (const m of matches) {
      try {
        const p0 = this.processMatch(m);
        if (p0) {
          const p = p0.catch((e) => this.log(`[${this.name}] ERROR in auction handler (m${m}): ${e instanceof Error ? e.stack : e}`));
          this.inflight.add(p);
          void p.finally(() => this.inflight.delete(p));
        }
      } catch (e) {
        this.log(`[${this.name}] ERROR processing match ${m}: ${errMsg(e)}`);
      }
    }
  }

  /** Canonical order per match: results -> strategy.onAuctionResult, then start, then the open auction. */
  private processMatch(matchId: bigint): Promise<void> | undefined {
    const store = this.store;
    const ms = store.matches.get(matchId);
    if (!ms || !store.amIn(matchId)) return undefined;

    // 1. Match start.
    if (ms.status.tag === "Running" && !this.started.has(matchId)) {
      this.started.add(matchId);
      const v = store.buildView(matchId, false);
      if (v) {
        this.log(
          `[${this.name}] match ${matchId} start: ${ms.auctionType.tag}, ${v.players.length} players ` +
            `(${v.players.filter((p) => p.isSim).length} sim), rack=${rackStr(v.myRack)}, ${ms.auctionDurationMs}ms auctions`,
        );
        this.guard("onMatchStart", () => this.strategy.onMatchStart?.(v));
      }
    }

    // 2. Results not yet shown to the strategy (and one log line each).
    for (const r of store.sortedResults(matchId)) {
      if (this.reported.has(r.auctionId)) continue;
      this.reported.add(r.auctionId);
      this.reportResult(matchId, r);
    }

    // 3. Match ended -> log + rejoin lobby.
    if (ms.status.tag === "Ended" && this.endedPending.has(matchId) && !this.endedLogged.has(matchId)) {
      this.endedPending.delete(matchId);
      this.endedLogged.add(matchId);
      this.logMatchEnd(matchId);
      this.maybeJoinLobby("match ended");
    }

    // 4. The open auction.
    if (ms.status.tag !== "Running") return undefined;
    let open: AuctionRow | undefined;
    for (const a of store.auctions.values()) {
      if (a.matchId !== matchId || a.status.tag !== "Open" || this.handled.has(a.id)) continue;
      if (!open || a.id > open.id) open = a;
    }
    if (!open) return undefined;
    this.handled.add(open.id);
    return this.handleAuction(open);
  }

  private reportResult(matchId: bigint, r: ResultRow): void {
    const store = this.store;
    const rec = store.recordOf(matchId, r);
    const view = store.buildView(matchId, true);
    const mine = this.myLog.get(r.auctionId);
    const iWon = r.winnerBotId !== undefined && r.winnerBotId !== null && r.winnerBotId === store.myBotId;
    const outcome =
      r.winnerBotId === undefined || r.winnerBotId === null
        ? "no sale"
        : iWon
          ? `WON paid ${num(r.paid)}`
          : `lost to bot ${r.winnerBotId} paid ${num(r.paid)}`;
    this.log(
      `[${this.name}] m${matchId} r${rec.round} '${rec.letter}' bid=${mine ? mine.bid : "-"} ${outcome}` +
        (mine ? ` | bal@bid=${mine.balAtBid} rack=${mine.rackSize}` : " | catch-up(no bid made by this process)") +
        ` bal=${view?.myBalance ?? "?"} score=${view?.myScore ?? "?"}` +
        (mine && mine.words.length ? ` words=${mine.words.join(",")}` : "") +
        (mine ? ` bidMs=${mine.bidMs.toFixed(0)}${mine.note ? " " + mine.note : ""}` : ""),
    );
    this.myLog.delete(r.auctionId);
    if (view) this.guard("onAuctionResult", () => this.strategy.onAuctionResult?.(view, rec));
  }

  private logMatchEnd(matchId: bigint): void {
    const v = this.store.buildView(matchId, false);
    if (!v) return;
    const sorted = [...v.players].sort((a, b) => b.score - a.score);
    const place = 1 + sorted.filter((p) => p.score > v.myScore).length;
    this.log(
      `[${this.name}] match ${matchId} ENDED: my score ${v.myScore} (place ${place}/${v.players.length}); ` +
        `scores ${sorted.map((p) => `${p.botId}${p.botId === v.myBotId ? "*" : ""}:${p.score}`).join(" ")}`,
    );
  }

  // ---------- the auction flow ----------

  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.stats.strategyErrors++;
      this.log(`[${this.name}] STRATEGY EXCEPTION in ${what}: ${errMsg(e)}`);
      return undefined;
    }
  }

  private async handleAuction(a: AuctionRow): Promise<void> {
    const store = this.store;
    const matchId = a.matchId;
    const letter = a.letter.toUpperCase();
    const tSeen = this.seenAt.get(a.id) ?? this.now();
    this.stats.auctions++;

    const view0 = store.buildView(matchId, true);
    const confirmed = store.buildView(matchId, false);
    if (!view0 || !confirmed) return;
    const last = view0.bagRemaining === 0;

    // ---- 1. words ----
    let rawWords: string[] = [];
    const rack0 = new Map(view0.myRack); // own copy: a strategy that mutates view.myRack must not corrupt validation
    const tw0 = this.now();
    const got = this.guard("words", () => this.strategy.words(view0));
    const wordsDt = this.now() - tw0;
    if (wordsDt > 150) this.log(`[${this.name}] WARNING slow strategy.words ${wordsDt.toFixed(0)}ms`);
    const wordsFailed = got === undefined;
    if (Array.isArray(got)) rawWords = got.filter((w): w is string => typeof w === "string");
    else if (!wordsFailed) this.log(`[${this.name}] strategy.words returned a non-array; ignoring`);
    let plan = this.sanitizeWords(rawWords, rack0);
    if (last) plan = this.topUpDump(matchId, plan, rack0, wordsFailed);
    this.stats.wordsMs.push(this.now() - tw0);

    // ---- 2. submit words (pipelined), tracking them as pending ----
    const pend: PendingWord[] = plan.map((w) => ({ word: w, counts: wordCounts(w), reward: safeReward(w), state: "inflight" as const }));
    const settles: Promise<void>[] = [];
    for (const p of pend) {
      store.addPending(matchId, p);
      this.stats.wordCalls++;
      settles.push(
        this.transport.submitWord(matchId, p.word).then(
          () => {
            // The SDK applies the reducer's table updates before resolving the promise, so the
            // confirmed rows already reflect this word: stop adjusting for it right away.
            p.state = "ok";
            store.dropPending(matchId, p);
          },
          (e) => {
            p.state = "failed";
            store.dropPending(matchId, p);
            this.stats.wordErrors++;
            this.log(`[${this.name}] m${matchId} word '${p.word}' FAILED: ${errMsg(e)}`);
          },
        ),
      );
    }

    // ---- 3. bid against the optimistic view ----
    const view1 = pend.length > 0 ? store.buildView(matchId, true)! : view0;
    const tb0 = this.now();
    const want = last ? 0 : this.computeBid(view1, letter);
    this.stats.bidComputeMs.push(this.now() - tb0);
    const confirmedBal = confirmed.myBalance;
    const capped = Math.min(want, confirmedBal);
    const sends: Promise<void>[] = [];
    let live = 0; // amount of the highest-sequence accepted bid reducer
    let liveSeq = 0;
    let seq = 0;
    let accepted = 0;
    let firstBidMs = -1;
    const note: string[] = [];
    if (last) note.push("last-auction");
    const sendBid = (amount: number, kind: "bid" | "optimistic" | "rebid"): Promise<void> => {
      if (firstBidMs < 0) firstBidMs = this.now() - tSeen;
      this.stats.bidCalls++;
      const mySeq = ++seq;
      return this.transport.submitBid(a.id, amount).then(
        () => {
          accepted++;
          if (mySeq > liveSeq) {
            live = amount;
            liveSeq = mySeq;
          }
          if (kind === "optimistic") {
            this.stats.optimisticAccepted++;
            note.push("opt-ok");
          }
        },
        (e) => this.onBidError(a, amount, kind, e, note),
      );
    };
    if (capped > 0) sends.push(sendBid(capped, "bid"));
    if (want > capped) sends.push(sendBid(want, "optimistic"));
    if (firstBidMs >= 0) this.stats.bidMs.push(firstBidMs);
    let rackSize = 0;
    for (const n of view1.myRack.values()) rackSize += n;
    this.myLog.set(a.id, { bid: want, balAtBid: view1.myBalance, rackSize, words: plan, bidMs: firstBidMs < 0 ? this.now() - tSeen : firstBidMs, note: "" });

    // ---- 4. settle: reconcile pending words, re-check the final bid ----
    await Promise.all([...settles, ...sends]);
    for (const p of pend) store.dropPending(matchId, p);
    const anyFailed = pend.some((p) => p.state === "failed");
    if (anyFailed) this.transport.resync?.(matchId);

    if (!last) {
      const stillOpen = store.auctions.get(a.id)?.status.tag === "Open" && store.matches.get(matchId)?.status.tag === "Running";
      if (stillOpen) {
        const view2 = store.buildView(matchId, true);
        if (view2) {
          let final = anyFailed ? this.computeBid(view2, letter) : want;
          final = Math.max(0, Math.min(final, view2.myBalance));
          const ambiguous = accepted > 1 && capped !== want; // two accepted bids: cannot tell which one the server kept
          if ((final !== live || ambiguous) && (final > 0 || live > 0)) {
            note.push(`rebid ${live}->${final}`);
            await sendBid(final, "rebid");
          }
          const lg = this.myLog.get(a.id);
          if (lg) lg.bid = live;
        }
      }
    }
    const lg = this.myLog.get(a.id);
    if (lg) {
      lg.bid = live;
      lg.note = note.join(" ");
    }
  }

  private onBidError(a: AuctionRow, amount: number, kind: string, e: unknown, note: string[]): void {
    const m = errMsg(e);
    this.stats.bidErrors++;
    if (/Insufficient balance/i.test(m)) {
      if (kind === "optimistic") {
        this.stats.optimisticRejected++;
        note.push("opt-rejected");
        return; // expected if the server did not apply the word rewards first
      }
      this.transport.resync?.(a.matchId);
      note.push("insufficient");
    } else if (/window expired|Auction closed/i.test(m)) {
      this.stats.lateBids++;
      note.push("LATE");
    } else if (/Not in this match|Unknown auction/i.test(m)) {
      note.push("notinmatch");
    }
    this.log(`[${this.name}] m${a.matchId} bid ${amount} on auction ${a.id} FAILED (${kind}): ${m}`);
  }

  private computeBid(view: NonNullable<ReturnType<LiveStore["buildView"]>>, letter: string): number {
    const t0 = this.now();
    const raw = this.guard("bid", () => this.strategy.bid(view, letter));
    const dt = this.now() - t0;
    if (dt > 150) this.log(`[${this.name}] WARNING slow strategy.bid ${dt.toFixed(0)}ms`);
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      if (raw !== undefined) this.log(`[${this.name}] strategy.bid returned ${String(raw)}; using 0`);
      return 0;
    }
    return Math.max(0, Math.min(Math.floor(raw), view.myBalance));
  }

  /** Normalise + validate the strategy's words against the running rack. Invalid words are dropped (logged). */
  private sanitizeWords(words: string[], rack: Map<string, number>): string[] {
    const left = new Map(rack);
    const out: string[] = [];
    for (const raw of words) {
      const w = raw.toUpperCase();
      if (!/^[A-Z]{2,}$/.test(w)) {
        this.log(`[${this.name}] dropped word '${raw}': not A-Z / <2 letters`);
        continue;
      }
      let dict = true;
      try {
        dict = W.isWord(w);
      } catch {
        dict = true; // dictionary unavailable: let the server decide
      }
      if (!dict) {
        this.log(`[${this.name}] dropped word '${w}': not in the dictionary`);
        continue;
      }
      const need = wordCounts(w);
      let ok = true;
      for (const [ch, n] of need) if ((left.get(ch) ?? 0) < n) ok = false;
      if (!ok) {
        this.log(`[${this.name}] dropped word '${w}': not spellable from the rack`);
        continue;
      }
      for (const [ch, n] of need) {
        const r = (left.get(ch) ?? 0) - n;
        if (r > 0) left.set(ch, r);
        else left.delete(ch);
      }
      out.push(w);
    }
    return out;
  }

  /** Last auction: play everything still playable (bestPartition of the leftover). */
  private topUpDump(matchId: bigint, plan: string[], rack: Map<string, number>, strategyFailed: boolean): string[] {
    try {
      const left = new Map(rack);
      for (const w of plan) {
        for (const [ch, n] of wordCounts(w)) {
          const r = (left.get(ch) ?? 0) - n;
          if (r > 0) left.set(ch, r);
          else left.delete(ch);
        }
      }
      let tiles = 0;
      for (const n of left.values()) tiles += n;
      if (tiles < 2) return plan;
      const res = W.bestPartition(W.rackToCounts(left), { timeBudgetMs: 25 });
      if (res.words.length === 0) return plan;
      if (!this.lastDumpLog.has(matchId)) {
        this.lastDumpLog.add(matchId);
        this.log(
          `[${this.name}] m${matchId} LAST AUCTION dump${strategyFailed ? " (strategy failed)" : " top-up"}: ` +
            `${res.words.join(",")} (+${res.total}${res.optimal ? "" : ", not proven optimal"})`,
        );
      }
      return [...plan, ...res.words];
    } catch (e) {
      this.log(`[${this.name}] last-auction dump failed: ${errMsg(e)}`);
      return plan;
    }
  }

  // ---------- lobby ----------

  runningMatchIds(): bigint[] {
    const out: bigint[] = [];
    for (const [id, m] of this.store.matches) if (m.status.tag === "Running" && this.store.amIn(id)) out.push(id);
    return out;
  }

  maybeJoinLobby(reason: string): void {
    if (!this.autoLobby || this.lobbyBusy) return;
    if (this.runningMatchIds().length > 0) return;
    const t = Date.now();
    if (t < this.lobbyCooldownUntil) return;
    this.lobbyBusy = true;
    this.lobbyCooldownUntil = t + 1500;
    this.transport.joinLobby().then(
      () => {
        this.lobbyBusy = false;
        this.log(`[${this.name}] joined lobby (${reason})`);
      },
      (e) => {
        this.lobbyBusy = false;
        const m = errMsg(e);
        if (/tournament/i.test(m)) this.lobbyCooldownUntil = Date.now() + 30_000;
        else if (/running match/i.test(m)) this.lobbyCooldownUntil = Date.now() + 5_000;
        this.log(`[${this.name}] join lobby refused (${reason}): ${m}`);
      },
    );
  }
}

function rackStr(r: Map<string, number>): string {
  return [...r.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([c, n]) => c.repeat(n))
    .join("");
}

function safeReward(word: string): number {
  try {
    return W.reward(word);
  } catch {
    return 0;
  }
}

export function summarizeStats(s: BotStats): string {
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
  return (
    `auctions=${s.auctions} bidCalls=${s.bidCalls} bidErrors=${s.bidErrors} late=${s.lateBids} ` +
    `wordCalls=${s.wordCalls} wordErrors=${s.wordErrors} stratErrors=${s.strategyErrors} ` +
    `optimistic ok/rejected=${s.optimisticAccepted}/${s.optimisticRejected} ` +
    `insert->bid ms avg=${avg(s.bidMs).toFixed(1)} max=${max(s.bidMs).toFixed(0)} ` +
    `words() ms avg=${avg(s.wordsMs).toFixed(1)} max=${max(s.wordsMs).toFixed(0)}`
  );
}
