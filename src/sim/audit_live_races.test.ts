// Audit tests (label: audit-live-races). Each test reproduces ONE suspected live-client defect against LiveBot
// with a hand-rolled Transport. Tests assert the DESIRED behaviour; a failing test = a confirmed defect.
//   nice -n 19 timeout 200 node --import tsx --test src/sim/audit_live_races.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import type { MatchView, Strategy } from "../core/types.js";
import { LiveBot, type Transport } from "../live/bot.js";
import { LiveStore, type AuctionRow, type MatchStateRow, type RackRow } from "../live/store.js";

const ME = 7n;
const MATCH = 1n;

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

function rackRows(rack: string): RackRow[] {
  const m = new Map<string, number>();
  for (const c of rack) m.set(c, (m.get(c) ?? 0) + 1);
  let i = 0n;
  return [...m].map(([letter, count]) => ({ id: 1000n + i++, matchId: MATCH, botId: ME, letter, count }));
}

function mk(strategy: Strategy, transport: Transport, balance: number, rack: string, bagTotal = 50) {
  const store = new LiveStore(ME);
  const logs: string[] = [];
  const bot = new LiveBot({ strategy, transport, store, log: (l) => logs.push(l), autoLobby: false });
  bot.onMatchState(matchRow(bagTotal));
  bot.onBot({ id: ME, isSimulated: false });
  bot.onParticipant({ matchId: MATCH, botId: ME, balance: BigInt(balance), score: 0n });
  bot.onParticipant({ matchId: MATCH, botId: 8n, balance: 90n, score: 5n });
  bot.replaceRack(MATCH, rackRows(rack));
  return { store, bot, logs };
}

function open(bot: LiveBot, id: bigint, letter: string): void {
  const a: AuctionRow = { id, matchId: MATCH, letter, status: { tag: "Open" } };
  bot.onAuction(a);
}

// ---------------------------------------------------------------------------------------------------------------
// D1 (low): a SYNCHRONOUS throw from transport.submitWord leaves the word in store.pending forever.
// buildView(withPending) then keeps treating the word as spent + rewarded: every later view for the match has an
// inflated balance and a short rack, and this auction's bid is never sent.
test("D1: sync throw from submitWord must not leave a pending word behind", async () => {
  const bids: number[] = [];
  let first = true;
  const transport: Transport = {
    submitWord: () => {
      if (first) {
        first = false;
        throw new Error("sync boom (e.g. serializer/socket exception)");
      }
      return Promise.resolve();
    },
    submitBid: (_a, amount) => {
      bids.push(amount);
      return Promise.resolve();
    },
    joinLobby: async () => {},
  };
  const strat: Strategy = { name: "d1", words: () => ["QUIZ"], bid: (v: MatchView) => Math.min(5, v.myBalance) };
  const { store, bot } = mk(strat, transport, 10, "QUIZE");
  open(bot, 500n, "A");
  await bot.idle();
  const leaked = store.pending.get(MATCH)?.length ?? 0;
  assert.equal(leaked, 0, "pending word leaked after the handler threw");
  assert.ok(bids.length > 0, "no bid was sent for the auction after the word call threw");
});

// ---------------------------------------------------------------------------------------------------------------
// D2 (low-medium): reducer promises of a dead connection never settle (SDK 2.12 without automatic reconnect does not
// call #failInFlightCalls on socket loss; verified by reading node_modules/spacetimedb/dist/index.mjs handleLoss()).
// LiveBot.lobbyBusy is then stuck true, and resetSession() does not clear it: the bot never joins a lobby again
// after the reconnect (until the process restarts).
test("D2: a joinLobby promise that never settles must not block lobby joins after resetSession()", async () => {
  let calls = 0;
  const transport: Transport = {
    submitWord: () => Promise.resolve(),
    submitBid: () => Promise.resolve(),
    joinLobby: () => {
      calls++;
      return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };
  const strat: Strategy = { name: "d2", words: () => [], bid: () => 0 };
  const store = new LiveStore(ME);
  const bot = new LiveBot({ strategy: strat, transport, store, log: () => {}, autoLobby: true });
  bot.maybeJoinLobby("startup"); // call 1: in flight when the connection dies
  assert.equal(calls, 1);
  bot.resetSession(); // what runner.ts does on the next connection
  // cooldown is 1.5 s wall clock; wait it out
  await new Promise((r) => setTimeout(r, 1600));
  bot.maybeJoinLobby("after reconnect");
  assert.equal(calls, 2, "lobby join was suppressed forever by a stale lobbyBusy flag");
});

// ---------------------------------------------------------------------------------------------------------------
// D3 (cosmetic/perf): on an ordered server (the real one: live logs show opt-ok 57, opt-rejected 0) every optimistic
// raise is followed by a redundant third submit_bid ("rebid") because `ambiguous` is true whenever two bids were
// accepted. 56 'rebid' notes appear in the live logs. It can arrive after close and log a spurious FAILED / LATE.
test("D3: ordered server, optimistic raise accepted -> exactly two bid calls (no redundant rebid)", async () => {
  const calls: string[] = [];
  let balance = 10;
  let score = 0;
  let chain: Promise<void> = Promise.resolve();
  const ordered = (run: () => void): Promise<void> => {
    const p = chain.then(() => new Promise<void>((r) => setTimeout(r, 5))).then(run);
    chain = p.catch(() => undefined);
    return p;
  };
  let bot!: LiveBot;
  const transport: Transport = {
    submitWord: (_m, w) => {
      calls.push(`word:${w}`);
      return ordered(() => {
        balance += 33;
        score += 33;
        // the SDK applies the table update before it resolves the reducer promise
        bot.onParticipant({ matchId: MATCH, botId: ME, balance: BigInt(balance), score: BigInt(score) });
        bot.replaceRack(MATCH, rackRows("E"));
      });
    },
    submitBid: (_a, amount) => {
      calls.push(`bid:${amount}`);
      return ordered(() => {
        if (amount > balance) throw new Error("Insufficient balance");
      });
    },
    joinLobby: async () => {},
  };
  const strat: Strategy = { name: "d3", words: () => ["QUIZ"], bid: (v: MatchView) => v.myBalance };
  const made = mk(strat, transport, 10, "QUIZE");
  bot = made.bot;
  open(bot, 501n, "A");
  await bot.idle();
  const bidCalls = calls.filter((c) => c.startsWith("bid:"));
  assert.equal(bidCalls.length, 2, `expected capped bid + optimistic raise only, got ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------------------------------------------
// D4 (informational, passes if the live code is right): a result that arrives while the handler is still awaiting its
// reducers must not crash and the match end must not be lost when the match ended during a disconnect.
test("D4: match that ended while disconnected still rejoins the lobby via the idle check path", () => {
  let lobbyCalls = 0;
  const transport: Transport = {
    submitWord: () => Promise.resolve(),
    submitBid: () => Promise.resolve(),
    joinLobby: async () => {
      lobbyCalls++;
    },
  };
  const strat: Strategy = { name: "d4", words: () => [], bid: () => 0 };
  const store = new LiveStore(ME);
  const bot = new LiveBot({ strategy: strat, transport, store, log: () => {}, autoLobby: true });
  bot.onParticipant({ matchId: MATCH, botId: ME, balance: 1n, score: 1n });
  // first sight of the match is already Ended (reconnect after the end): endedPending is never set
  bot.onMatchState({ ...matchRow(0), status: { tag: "Ended" } });
  assert.equal(bot.runningMatchIds().length, 0);
  bot.maybeJoinLobby("idle check");
  assert.equal(lobbyCalls, 1, "idle check must still be able to rejoin the lobby");
});
