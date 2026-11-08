// Mock-connection unit tests of the live auction -> words -> bid flow.
//   nice -n 19 node --import tsx --test src/live/mock.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import type { MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { LiveBot, type Transport } from "./bot.js";
import { LiveStore, type AuctionRow, type MatchStateRow, type RackRow } from "./store.js";

const ME = 7n;
const MATCH = 1n;

interface MockOpts {
  /** true: reducers from this connection are applied in send order (word reward visible to a following bid). */
  ordered: boolean;
  wordDelayMs?: number;
  failWords?: boolean;
}

class MockServer {
  balance: number;
  score = 0;
  rack = new Map<string, number>();
  bids = new Map<bigint, number>();
  calls: string[] = [];
  bot!: LiveBot;
  resyncs = 0;
  private nextRack = 100n;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    public opts: MockOpts,
    balance: number,
    rack: string,
  ) {
    this.balance = balance;
    for (const c of rack) this.rack.set(c, (this.rack.get(c) ?? 0) + 1);
  }

  rackRows(): RackRow[] {
    const rows: RackRow[] = [];
    let i = 0n;
    for (const [letter, count] of this.rack) rows.push({ id: 1000n + i++, matchId: MATCH, botId: ME, letter, count });
    return rows;
  }
  pushState(bot: LiveBot): void {
    bot.onParticipant({ matchId: MATCH, botId: ME, balance: BigInt(this.balance), score: BigInt(this.score) });
    bot.replaceRack(MATCH, this.rackRows());
  }

  transport(): Transport {
    return {
      submitBid: (auctionId, amount) => {
        this.calls.push(`bid:${amount}`);
        const run = () => {
          if (amount > this.balance) throw new Error("Insufficient balance");
          this.bids.set(auctionId, amount);
        };
        return this.exec(run, 2);
      },
      submitWord: (_m, word) => {
        this.calls.push(`word:${word}`);
        const run = () => {
          if (this.opts.failWords) throw new Error(`'${word}' is not in the dictionary`);
          for (const c of word) {
            const have = this.rack.get(c) ?? 0;
            if (have < 1) throw new Error(`Not enough '${c}'`);
            if (have === 1) this.rack.delete(c);
            else this.rack.set(c, have - 1);
          }
          const r = W.reward(word);
          this.balance += r;
          this.score += r;
          this.pushState(this.bot); // cache updated before the promise resolves (SDK behaviour)
        };
        return this.exec(run, this.opts.wordDelayMs ?? 20);
      },
      joinLobby: async () => {
        this.calls.push("lobby");
      },
      resync: () => {
        this.resyncs++;
        this.pushState(this.bot);
      },
    };
  }

  private exec(run: () => void, delayMs: number): Promise<void> {
    if (this.opts.ordered) {
      // Strictly sequential execution in send order.
      const p = this.chain.then(() => new Promise<void>((res) => setTimeout(res, delayMs))).then(run);
      this.chain = p.catch(() => undefined);
      return p;
    }
    // Concurrent: each reducer finishes after its own delay (bids are quick, words slow).
    return new Promise<void>((res, rej) =>
      setTimeout(() => {
        try {
          run();
          res();
        } catch (e) {
          rej(e);
        }
      }, delayMs),
    );
  }
}

function matchRow(bagTotal: number): MatchStateRow {
  return {
    id: MATCH,
    status: { tag: "Running" },
    currentRound: 68 - bagTotal,
    bagTotal,
    auctionType: { tag: "Vickrey" },
    auctionDurationMs: 1000n,
    startingRackSize: 5,
  };
}

function setup(strategy: Strategy, opts: MockOpts, balance: number, rack: string, bagTotal = 50) {
  const server = new MockServer(opts, balance, rack);
  const store = new LiveStore(ME);
  const logs: string[] = [];
  const bot = new LiveBot({ strategy, transport: server.transport(), store, log: (l) => logs.push(l), autoLobby: false });
  server.bot = bot;
  bot.onMatchState(matchRow(bagTotal));
  bot.onBot({ id: ME, isSimulated: false });
  bot.onBot({ id: 8n, isSimulated: true, strategy: { tag: "Aggressive" } });
  bot.onParticipant({ matchId: MATCH, botId: 8n, balance: 90n, score: 5n });
  server.pushState(bot);
  return { server, store, bot, logs };
}

function openAuction(bot: LiveBot, id: bigint, letter: string): void {
  const a: AuctionRow = { id, matchId: MATCH, letter, status: { tag: "Open" } };
  bot.onAuction(a);
}

const bidAll: Strategy["bid"] = (view: MatchView) => view.myBalance;

test("words are sent before the bid; bid sees post-word balance; ordered server accepts the optimistic raise", async () => {
  const seen: { rackBefore: string; balBefore: number; balAtBid: number; rackAtBid: string }[] = [];
  let before = { rack: "", bal: 0 };
  const strat: Strategy = {
    name: "t1",
    words(v) {
      before = { rack: [...v.myRack.keys()].sort().join(""), bal: v.myBalance };
      return ["QUIZ"];
    },
    bid(v) {
      seen.push({ rackBefore: before.rack, balBefore: before.bal, balAtBid: v.myBalance, rackAtBid: [...v.myRack.keys()].sort().join("") });
      return v.myBalance;
    },
  };
  const { server, bot } = setup(strat, { ordered: true }, 10, "QUIZE");
  openAuction(bot, 500n, "A");
  await bot.idle();
  assert.equal(server.calls[0], "word:QUIZ");
  assert.equal(server.calls[1], "bid:10", "capped bid first");
  assert.equal(server.calls[2], "bid:43", "then the optimistic raise (10 + reward 33)");
  assert.equal(seen[0]!.balBefore, 10);
  assert.equal(seen[0]!.balAtBid, 43, "bid() must see the balance including the pending reward");
  assert.equal(seen[0]!.rackAtBid, "E", "word letters treated as spent");
  assert.equal(server.bids.get(500n), 43);
  assert.equal(bot.stats.optimisticAccepted, 1);
  assert.equal(bot.stats.optimisticRejected, 0);
  assert.equal(bot.stats.bidErrors, 0);
});

test("unordered server: optimistic raise is rejected, then re-sent once the word reward landed", async () => {
  const strat: Strategy = { name: "t2", words: () => ["QUIZ"], bid: bidAll };
  const { server, bot } = setup(strat, { ordered: false, wordDelayMs: 40 }, 10, "QUIZE");
  openAuction(bot, 501n, "A");
  await bot.idle();
  assert.equal(bot.stats.optimisticRejected, 1);
  assert.equal(server.bids.get(501n), 43, "final bid raised to the real balance after settle");
  assert.ok(server.calls.filter((c) => c.startsWith("bid:")).length >= 3);
});

test("no words: single bid, no extra calls", async () => {
  const strat: Strategy = { name: "t3", words: () => [], bid: () => 12 };
  const { server, bot } = setup(strat, { ordered: true }, 100, "AEIOU");
  openAuction(bot, 502n, "Z");
  await bot.idle();
  assert.deepEqual(server.calls, ["bid:12"]);
  assert.equal(server.bids.get(502n), 12);
});

test("strategy exceptions never escape; safe defaults (no words, bid 0)", async () => {
  const strat: Strategy = {
    name: "boom",
    words() {
      throw new Error("words exploded");
    },
    bid() {
      throw new Error("bid exploded");
    },
    onAuctionResult() {
      throw new Error("result exploded");
    },
  };
  const { server, bot, logs } = setup(strat, { ordered: true }, 50, "QUIZE");
  openAuction(bot, 503n, "A");
  await bot.idle();
  assert.deepEqual(server.calls, [], "no words, bid 0 -> nothing sent");
  assert.ok(bot.stats.strategyErrors >= 2);
  assert.ok(logs.some((l) => l.includes("STRATEGY EXCEPTION in words")));
  // A result must also not crash.
  bot.onResult({ auctionId: 503n, matchId: MATCH, letter: "A", winnerBotId: 8n, paid: 5n });
  await bot.idle();
  assert.ok(bot.stats.strategyErrors >= 3);
});

test("last auction: broken strategy still dumps the rack with bestPartition, and does not bid", async () => {
  const strat: Strategy = {
    name: "boom2",
    words() {
      throw new Error("nope");
    },
    bid: bidAll,
  };
  const { server, bot } = setup(strat, { ordered: true }, 30, "QUIZEAT", 0);
  openAuction(bot, 504n, "B");
  await bot.idle();
  const wordCalls = server.calls.filter((c) => c.startsWith("word:"));
  assert.ok(wordCalls.length >= 1, "dump words were submitted");
  assert.equal(server.calls.filter((c) => c.startsWith("bid:")).length, 0, "no bid on the last auction");
  const best = W.bestPartition(W.rackToCounts(new Map([..."QUIZEAT"].map((c) => [c, 1] as [string, number]))), { timeBudgetMs: 100 });
  assert.equal(server.score, best.total, "scored the optimal partition total");
});

test("last auction: strategy words plus top-up of the leftover", async () => {
  const strat: Strategy = { name: "t5", words: () => ["QUIZ"], bid: bidAll };
  const { server, bot } = setup(strat, { ordered: true }, 5, "QUIZEAT", 0);
  openAuction(bot, 505n, "B");
  await bot.idle();
  assert.equal(server.calls[0], "word:QUIZ");
  assert.ok(server.calls.some((c, i) => i > 0 && c.startsWith("word:")), "leftover EAT dumped too");
});

test("invalid / unspellable words are dropped before sending", async () => {
  const strat: Strategy = { name: "t6", words: () => ["XYZZYQ", "QUIZ", "QUIZ", "zzz", "A"], bid: () => 3 };
  const { server, bot, logs } = setup(strat, { ordered: true }, 20, "QUIZE");
  openAuction(bot, 506n, "A");
  await bot.idle();
  assert.deepEqual(
    server.calls.filter((c) => c.startsWith("word:")),
    ["word:QUIZ"],
  );
  assert.ok(logs.some((l) => l.includes("dropped word")));
});

test("a failing word reducer triggers a resync and a recomputed bid", async () => {
  const strat: Strategy = { name: "t7", words: () => ["QUIZ"], bid: bidAll };
  const { server, bot, logs } = setup(strat, { ordered: true, failWords: true }, 10, "QUIZE");
  openAuction(bot, 507n, "A");
  await bot.idle();
  assert.equal(bot.stats.wordErrors, 1);
  assert.ok(server.resyncs >= 1);
  assert.ok(logs.some((l) => l.includes("FAILED")));
  assert.equal(server.bids.get(507n), 10, "bid falls back to the real balance");
});

test("two matches at once are independent", async () => {
  const strat: Strategy = { name: "t8", words: () => [], bid: (v) => (v.matchId === 1 ? 4 : 9) };
  const { server, bot } = setup(strat, { ordered: true }, 100, "AEIOU");
  // second match, id 2
  bot.onMatchState({ ...matchRow(40), id: 2n });
  bot.onParticipant({ matchId: 2n, botId: ME, balance: 100n, score: 0n });
  bot.onParticipant({ matchId: 2n, botId: 8n, balance: 100n, score: 0n });
  bot.onRack({ id: 2000n, matchId: 2n, botId: ME, letter: "E", count: 5 });
  openAuction(bot, 600n, "E");
  bot.onAuction({ id: 601n, matchId: 2n, letter: "T", status: { tag: "Open" } });
  await bot.idle();
  assert.equal(server.bids.get(600n), 4);
  assert.equal(server.bids.get(601n), 9);
});

test("insert->bid latency is measured", async () => {
  const strat: Strategy = { name: "t9", words: () => [], bid: () => 5 };
  const { bot } = setup(strat, { ordered: true }, 100, "AEIOU");
  openAuction(bot, 700n, "E");
  await bot.idle();
  assert.equal(bot.stats.bidMs.length, 1);
  assert.ok(bot.stats.bidMs[0]! < 50, `bid sent within 50 ms of the insert (was ${bot.stats.bidMs[0]})`);
});

test("view builder: players, sim tags, histories, safe bigint conversion", () => {
  const store = new LiveStore(ME);
  store.upsertMatch(matchRow(40));
  store.upsertBot({ id: ME, isSimulated: false });
  store.upsertBot({ id: 8n, isSimulated: true, strategy: { tag: "Cheapskate" } });
  store.upsertParticipant({ matchId: MATCH, botId: ME, balance: 77n, score: 12n });
  store.upsertParticipant({ matchId: MATCH, botId: 8n, balance: 2n ** 70n, score: 3n });
  store.upsertRack({ id: 1n, matchId: MATCH, botId: ME, letter: "e", count: 2 });
  store.upsertRack({ id: 2n, matchId: 99n, botId: ME, letter: "Z", count: 1 }); // other match
  store.upsertResult({ auctionId: 11n, matchId: MATCH, letter: "A", winnerBotId: 8n, paid: 3n, closedAt: { microsSinceUnixEpoch: 1000n } });
  store.upsertResult({ auctionId: 10n, matchId: MATCH, letter: "Q", winnerBotId: undefined, paid: 0n, closedAt: { microsSinceUnixEpoch: 500n } });
  store.upsertWord({ id: 1n, matchId: MATCH, botId: 8n, word: "cat", totalReward: 5n, playedAt: { microsSinceUnixEpoch: 1000n } });
  const v = store.buildView(MATCH)!;
  assert.equal(v.myBalance, 77);
  assert.deepEqual([...v.myRack], [["E", 2]]);
  assert.equal(v.players.find((p) => p.botId === 8)!.simStrategy, "Cheapskate");
  assert.equal(v.players.find((p) => p.botId === 8)!.balance, Number.MAX_SAFE_INTEGER, "saturates instead of throwing");
  assert.deepEqual(v.auctionHistory.map((r) => [r.round, r.letter, r.winnerBotId, r.paid]), [
    [1, "Q", null, 0],
    [2, "A", 8, 3],
  ]);
  // A sim word is played in the same transaction as the close of auction 2 (playedAt == closedAt 1000) -> round 2.
  assert.deepEqual(v.wordHistory, [{ round: 2, botId: 8, word: "CAT", reward: 5 }]);
  assert.equal(v.bagRemaining, 40);
  assert.equal(v.auctionType, "Vickrey");
  assert.equal(store.buildView(12345n), null);
});

test("a strategy that mutates view.myRack cannot corrupt word validation", async () => {
  const strat: Strategy = {
    name: "mutator",
    words(v) {
      v.myRack.clear();
      return ["QUIZ"];
    },
    bid: () => 1,
  };
  const { server, bot } = setup(strat, { ordered: true }, 10, "QUIZE");
  openAuction(bot, 800n, "A");
  await bot.idle();
  assert.equal(server.calls[0], "word:QUIZ");
});

test("every strategy in src/strategies loads and survives the live flow", async () => {
  const { readdirSync } = await import("node:fs");
  const { loadStrategy } = await import("./strategy_loader.js");
  const dir = new URL("../strategies/", import.meta.url);
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"))
    .map((f) => f.replace(/\.ts$/, ""));
  for (const name of names) {
    const l = await loadStrategy(name, true);
    if (l.fellBack) {
      console.log(`  (skipping '${name}': does not load as a strategy: ${l.error})`);
      continue;
    }
    for (const bag of [50, 0]) {
      const { server, bot, logs } = setup(l.strategy, { ordered: true }, 60, "QUIZEAT", bag);
      openAuction(bot, BigInt(900 + bag), "E");
      await bot.idle();
      assert.equal(bot.stats.strategyErrors, 0, `${name}: strategy threw: ${logs.filter((x) => x.includes("EXCEPTION")).join(" | ")}`);
      assert.equal(bot.stats.wordErrors, 0, `${name}: word reducer failed`);
      assert.equal(bot.stats.bidErrors - bot.stats.optimisticRejected, 0, `${name}: bid error`);
      assert.ok(server.score >= 0);
    }
  }
});
