// Tests for the simulator: every rule from docs/GAME_SPEC.md that the engine claims to replicate.
// Run:  nice -n 19 node --import tsx --test src/sim/engine.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MatchView, SimStrategyTag, Strategy } from "../core/types.js";
import {
  BAG_SIZE,
  DEFAULT_BAG,
  checkWord,
  findBestPlayable,
  findBestPlayableRef,
  fullBagIndices,
  indexLetter,
  letterIndex,
  letterValue,
  lengthMultiplier,
  wordReward,
} from "./dict.js";
import {
  type EngineEvent,
  type Participant,
  SIM_BOTS,
  makeBag,
  resolveAuction,
  runMatch,
  simDecideBid,
} from "./engine.js";
import { hash32, mulberry32, shuffleInPlace } from "./rng.js";
import { BASELINES, starterWord } from "./baselines.js";
import { loadRegistry, type Registry } from "./registry.js";
import { runBatch } from "./harness.js";
import { readFileSync } from "node:fs";

// ---------- helpers ----------

/** A valid 98-tile draw order that starts with `prefix` (letters taken from the standard bag, rest in A-Z order). */
function bagWithPrefix(prefix: string): number[] {
  const rest = Array.from(fullBagIndices());
  const out: number[] = [];
  for (const ch of prefix) {
    const k = rest.indexOf(letterIndex(ch));
    assert.ok(k >= 0, `prefix needs more '${ch}' than the bag holds`);
    out.push(rest.splice(k, 1)[0]!);
  }
  return out.concat(rest);
}

const sim = (tag: SimStrategyTag, name = `sim-${tag}`): Participant => ({ kind: "sim", name, tag });
const real = (name: string, strategy: Strategy): Participant => ({ kind: "real", name, strategy });

/** A strategy that never plays and bids a fixed amount (or via fn). */
function bidder(bid: number | ((v: MatchView, letter: string) => number), words: (v: MatchView) => string[] = () => []): Strategy {
  return {
    name: "scripted",
    words,
    bid: typeof bid === "number" ? () => bid : bid,
  };
}

function record(cfgEvents: EngineEvent[]) {
  return (e: EngineEvent) => cfgEvents.push(e);
}

function randomRack(rng: () => number, size: number): Map<string, number> {
  const bag = Array.from(fullBagIndices());
  shuffleInPlace(bag, rng);
  const rack = new Map<string, number>();
  for (let i = 0; i < size; i++) {
    const l = indexLetter(bag[i]!);
    rack.set(l, (rack.get(l) ?? 0) + 1);
  }
  return rack;
}

// ---------- dictionary / scoring ----------

describe("dictionary and scoring", () => {
  test("wordlist has 172,820 words and checkWord mirrors submit_word validation", () => {
    assert.equal(readFileSync(new URL("../../data/wordlist.txt", import.meta.url), "utf8").split("\n").filter(Boolean).length, 172820);
    assert.deepEqual(checkWord("cat"), { ok: true, word: "CAT" }); // server uppercases a-z first
    assert.deepEqual(checkWord("xi"), { ok: true, word: "XI" });
    assert.deepEqual(checkWord("QI"), { ok: false, reason: "not-in-dictionary" }); // not in THIS wordlist
    assert.deepEqual(checkWord("A"), { ok: false, reason: "format" }); // < 2 letters
    assert.deepEqual(checkWord("C4T"), { ok: false, reason: "format" }); // A-Z only
    assert.deepEqual(checkWord("CAT "), { ok: false, reason: "format" });
    assert.deepEqual(checkWord("ZZZZ"), { ok: false, reason: "not-in-dictionary" });
    assert.deepEqual(checkWord(42), { ok: false, reason: "format" });
  });

  test("bag is 98 tiles with the standard distribution", () => {
    assert.equal(BAG_SIZE, 98);
    assert.equal(DEFAULT_BAG.reduce((s, [, n]) => s + n, 0), 98);
    const counts = new Map<string, number>();
    for (const i of fullBagIndices()) counts.set(indexLetter(i), (counts.get(indexLetter(i)) ?? 0) + 1);
    for (const [l, n] of DEFAULT_BAG) assert.equal(counts.get(l), n, l);
  });

  test("length multiplier and floor(base*num/den) rewards", () => {
    assert.deepEqual([2, 3, 4, 5, 6, 7, 9].map(lengthMultiplier), [[1, 1], [1, 1], [3, 2], [2, 1], [5, 2], [3, 1], [3, 1]]);
    assert.equal(wordReward("QI"), 11); // 10 + 1, x1 (pure arithmetic; QI itself is not in the wordlist)
    assert.equal(wordReward("CAT"), 5); // 3+1+1, x1
    assert.equal(wordReward("JAZZ"), 43); // (8+1+10+10)=29 x1.5 = 43.5 -> 43 (floor)
    assert.equal(wordReward("JAZZ"), Math.floor((29 * 3) / 2));
    assert.equal(wordReward("WORDS"), 2 * (4 + 1 + 1 + 2 + 1)); // x2 = 18
    assert.equal(wordReward("BRIGHT"), Math.floor((3 + 1 + 1 + 2 + 4 + 1) * 2.5)); // 12*2.5 = 30
    assert.equal(wordReward("QUIZZES"), 3 * (10 + 1 + 1 + 10 + 10 + 1 + 1)); // x3 = 102
    assert.equal(wordReward("FARMS"), 2 * (4 + 1 + 1 + 3 + 1)); // 20
    assert.equal(wordReward("SPRING"), Math.floor((1 + 3 + 1 + 1 + 1 + 2) * 2.5)); // 9*2.5=22.5 -> 22
  });

  test("trie findBestPlayable == literal server scan on >= 2000 random racks (minLen 3 and 2)", () => {
    const rng = mulberry32(2024);
    let checked = 0;
    for (let i = 0; i < 2100; i++) {
      const size = 1 + Math.floor(rng() * 22);
      const rack = randomRack(rng, size);
      for (const minLen of [3, 2]) {
        const fast = findBestPlayable(rack, minLen);
        const ref = findBestPlayableRef(rack, minLen);
        assert.equal(fast, ref, `rack ${[...rack].map(([l, n]) => l.repeat(n)).join("")} minLen ${minLen}`);
      }
      checked++;
    }
    assert.ok(checked >= 2000);
  });

  test("trie findBestPlayable == server scan for minLen 5 and 7 (used by baselines) on 300 racks", () => {
    const rng = mulberry32(77);
    for (let i = 0; i < 300; i++) {
      const rack = randomRack(rng, 4 + Math.floor(rng() * 18));
      for (const minLen of [5, 7]) assert.equal(findBestPlayable(rack, minLen), findBestPlayableRef(rack, minLen));
    }
  });

  test("starter bot's word choice == literal port of bot-starter chooseWord on 1000 racks", () => {
    // literal port of bot-starter/src/strategy.ts chooseWord with its dictionary prep (length desc, stable sort)
    const dict = readFileSync(new URL("../../data/wordlist.txt", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2);
    dict.sort((a, b) => b.length - a.length);
    const canSpell = (word: string, rack: Map<string, number>) => {
      const used: Record<string, number> = {};
      for (const c of word) {
        used[c] = (used[c] ?? 0) + 1;
        if (used[c]! > (rack.get(c) ?? 0)) return false;
      }
      return true;
    };
    const chooseWord = (rack: Map<string, number>) => {
      let tiles = 0;
      for (const n of rack.values()) tiles += n;
      for (const w of dict) if (w.length <= tiles && canSpell(w, rack)) return w;
      return null;
    };
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const rack = randomRack(rng, 1 + Math.floor(rng() * 16));
      assert.equal(starterWord(rack), chooseWord(rack));
    }
  });
});

// ---------- sim bot bidding ----------

describe("sim bots (decideBid)", () => {
  test("base bids per strategy, vowel bonus, jitter, clamps", () => {
    // Cheapskate: value-1
    assert.equal(simDecideBid("Cheapskate", "Q", 100, 0), 9);
    assert.equal(simDecideBid("Cheapskate", "E", 100, 0), 1); // base 0 -> floor of 1
    assert.equal(simDecideBid("Cheapskate", "E", 100, -2), 1);
    assert.equal(simDecideBid("Cheapskate", "K", 100, 2), 6);
    // ValueBidder: value
    assert.equal(simDecideBid("ValueBidder", "Z", 100, 0), 10);
    assert.equal(simDecideBid("ValueBidder", "D", 100, -2), 1); // 0 -> 1
    assert.equal(simDecideBid("ValueBidder", "J", 100, 1), 9);
    // Aggressive: value + 4 for vowel, +2 otherwise
    assert.equal(simDecideBid("Aggressive", "A", 100, 0), 5);
    assert.equal(simDecideBid("Aggressive", "U", 100, 2), 7);
    assert.equal(simDecideBid("Aggressive", "B", 100, 0), 5);
    assert.equal(simDecideBid("Aggressive", "X", 100, -2), 8);
    // clamp to balance, then to >= 0 (a broke sim does not bid)
    assert.equal(simDecideBid("Aggressive", "Q", 7, 2), 7);
    assert.equal(simDecideBid("ValueBidder", "Q", 0, 0), 0);
    assert.equal(simDecideBid("Cheapskate", "E", 0, 2), 0);
  });

  test("six named sims map to the right strategies", () => {
    const m = Object.fromEntries(SIM_BOTS.map((s) => [s.name, s.tag]));
    assert.deepEqual(m, {
      "Cheapo-sim": "Cheapskate", "Snippet-sim": "Cheapskate",
      "Valor-sim": "ValueBidder", "Hagrid-sim": "ValueBidder",
      "Brutus-sim": "Aggressive", "Maverick-sim": "Aggressive",
    });
  });

  test("engine jitter is uniform on {-2..2} for every sim strategy", () => {
    for (const tag of ["Cheapskate", "ValueBidder", "Aggressive"] as const) {
      const hist = new Map<number, number>();
      let n = 0;
      for (let mi = 0; mi < 1500; mi++) {
        const ev: EngineEvent[] = [];
        // one sim vs a never-bidding real bot => the sim wins everything and keeps a healthy balance
        runMatch([sim(tag), real("idle", bidder(0))], { auctionType: "Vickrey", seed: 5, matchIndex: mi, onEvent: record(ev) });
        const opens = new Map<number, string>();
        for (const e of ev) {
          if (e.type === "open") opens.set(e.round, e.letter);
          if (e.type === "bids" && e.round <= 8) {
            const b = e.bids.find((x) => x.source === "sim");
            if (!b) continue;
            const letter = opens.get(e.round)!;
            const value = letterValue(letter);
            const base = tag === "Cheapskate" ? value - 1 : tag === "ValueBidder" ? value : value + ("AEIOU".includes(letter) ? 4 : 2);
            if (base - 2 < 1) continue; // lower clamp would hide the jitter
            const j = b.amount - base;
            hist.set(j, (hist.get(j) ?? 0) + 1);
            n++;
          }
        }
      }
      assert.deepEqual([...hist.keys()].sort((a, b) => a - b), [-2, -1, 0, 1, 2], tag);
      for (const [j, c] of hist) assert.ok(Math.abs(c / n - 0.2) < 0.035, `${tag} jitter ${j}: ${c}/${n}`);
    }
  });
});

// ---------- auction resolution ----------

describe("auction resolution (closeAuction)", () => {
  const rng = () => mulberry32(1);
  const bal = [100, 100, 100, 100];

  test("Vickrey: highest wins and pays the second-highest bid", () => {
    const o = resolveAuction([{ seat: 0, amount: 5 }, { seat: 1, amount: 9 }, { seat: 2, amount: 7 }], bal, "Vickrey", rng());
    assert.deepEqual(o, { winner: 1, topBid: 9, paid: 7, transferred: true });
  });

  test("Vickrey: sole bidder pays min(1, top)", () => {
    assert.equal(resolveAuction([{ seat: 2, amount: 40 }], bal, "Vickrey", rng()).paid, 1);
    assert.equal(resolveAuction([{ seat: 2, amount: 1 }], bal, "Vickrey", rng()).paid, 1);
  });

  test("FirstPrice: winner pays own bid (sole or not)", () => {
    assert.equal(resolveAuction([{ seat: 0, amount: 5 }, { seat: 1, amount: 9 }], bal, "FirstPrice", rng()).paid, 9);
    assert.equal(resolveAuction([{ seat: 3, amount: 40 }], bal, "FirstPrice", rng()).paid, 40);
  });

  test("only bids > 0 count; no positive bid => no winner, nothing paid", () => {
    const none = resolveAuction([{ seat: 0, amount: 0 }, { seat: 1, amount: 0 }], bal, "Vickrey", rng());
    assert.deepEqual(none, { winner: -1, topBid: 0, paid: 0, transferred: false });
    // a zero bid is not a "second bidder": the sole positive bidder still pays the reserve
    const o = resolveAuction([{ seat: 0, amount: 0 }, { seat: 1, amount: 12 }], bal, "Vickrey", rng());
    assert.deepEqual(o, { winner: 1, topBid: 12, paid: 1, transferred: true });
    assert.deepEqual(resolveAuction([], bal, "FirstPrice", rng()), { winner: -1, topBid: 0, paid: 0, transferred: false });
  });

  test("ties are broken uniformly at random; second price equals the tied amount", () => {
    for (const k of [2, 3]) {
      const wins = new Array<number>(k).fill(0);
      const N = 6000;
      for (let i = 0; i < N; i++) {
        const bids = Array.from({ length: k }, (_, s) => ({ seat: s, amount: 6 }));
        bids.push({ seat: 3, amount: 2 });
        const o = resolveAuction(bids, bal, "Vickrey", mulberry32(hash32(9, i)));
        assert.ok(o.winner >= 0 && o.winner < k, "loser with the lower bid must not win");
        assert.equal(o.paid, 6);
        wins[o.winner]!++;
      }
      for (const w of wins) assert.ok(Math.abs(w / N - 1 / k) < 0.035, `k=${k}: ${wins}`);
    }
  });

  test("winner gets the letter only if balance >= paid", () => {
    const o = resolveAuction([{ seat: 0, amount: 30 }], [0.5, 9], "FirstPrice", rng()); // balance 0.5 < 30
    assert.equal(o.winner, 0);
    assert.equal(o.paid, 30);
    assert.equal(o.transferred, false);
    assert.equal(resolveAuction([{ seat: 1, amount: 9 }], [0, 9], "FirstPrice", rng()).transferred, true); // exactly enough
  });
});

// ---------- match structure ----------

describe("match flow", () => {
  test("deal order: startingRackSize tiles per seat in seat order, then the first auction letter", () => {
    const ev: EngineEvent[] = [];
    const bag = bagWithPrefix("CATSEDOGSIBIRDNZ");
    runMatch([real("a", bidder(0)), real("b", bidder(0)), real("c", bidder(0))], {
      auctionType: "Vickrey", bag, onEvent: record(ev),
    });
    const deals = ev.filter((e) => e.type === "deal") as Extract<EngineEvent, { type: "deal" }>[];
    assert.deepEqual(deals.map((d) => d.letters), ["CATSE", "DOGSI", "BIRDN"]);
    const firstOpen = ev.find((e) => e.type === "open") as Extract<EngineEvent, { type: "open" }>;
    assert.equal(firstOpen.letter, "Z");
    assert.equal(firstOpen.round, 1);
    assert.equal(firstOpen.bagRemaining, 98 - 16);
  });

  test("68 auctions for 6 players x 5 tiles; last one (and only it) has bagRemaining 0", () => {
    const seen: { round: number; bagRemaining: number; balance: number; score: number }[] = [];
    const strat: Strategy = {
      name: "probe",
      words: (v) => { seen.push({ round: v.round, bagRemaining: v.bagRemaining, balance: v.myBalance, score: v.myScore }); return []; },
      bid: () => 0,
    };
    const res = runMatch([real("p", strat), sim("Cheapskate"), sim("ValueBidder"), sim("Aggressive"), sim("Aggressive"), sim("Cheapskate")], { auctionType: "Vickrey", seed: 3 });
    assert.equal(res.auctions, 68);
    assert.equal(seen.length, 68);
    seen.forEach((s, i) => {
      assert.equal(s.round, i + 1);
      assert.equal(s.bagRemaining, 98 - 30 - (i + 1)); // letter already drawn
    });
    assert.equal(seen[67]!.bagRemaining, 0);
    assert.ok(seen.slice(0, 67).every((s) => s.bagRemaining > 0));
    assert.equal(seen[0]!.balance, 100);
    assert.equal(seen[0]!.score, 0);
  });

  test("other sizes: 4 players x 7 tiles = 70 auctions; 2 x 5 = 88", () => {
    const four = [0, 1, 2, 3].map((i) => real(`r${i}`, bidder(0)));
    assert.equal(runMatch(four, { auctionType: "FirstPrice", startingRackSize: 7, seed: 1 }).auctions, 70);
    assert.equal(runMatch([real("a", bidder(0)), real("b", bidder(0))], { auctionType: "Vickrey", seed: 1 }).auctions, 88);
  });

  test("match ends right after the last auction; no further callbacks", () => {
    const ev: EngineEvent[] = [];
    runMatch([real("a", bidder(0)), real("b", bidder(0))], { auctionType: "Vickrey", seed: 2, onEvent: record(ev) });
    const last = ev[ev.length - 1]!;
    assert.equal(last.type, "end");
    const opens = ev.filter((e) => e.type === "open");
    assert.equal(opens.length, 88);
    assert.equal(ev[ev.length - 2]!.type, "close");
  });

  test("unbid letters are discarded: auctions still run, nobody holds them", () => {
    const res = runMatch([real("a", bidder(0)), real("b", bidder(0)), real("c", bidder(0))], { auctionType: "Vickrey", seed: 4 });
    assert.equal(res.auctions, 98 - 15);
    assert.equal(res.discarded, 98 - 15);
    for (const s of res.seats) {
      assert.equal(s.tilesLeft, 5);
      assert.equal(s.balance, 100);
      assert.equal(s.score, 0);
      assert.equal(s.auctionsWon, 0);
    }
  });

  test("tile conservation: leftover + played + discarded == 98", () => {
    for (let mi = 0; mi < 20; mi++) {
      const ev: EngineEvent[] = [];
      const res = runMatch(
        [real("s", BASELINES["starter"]!()), real("v", BASELINES["value-plus"]!()), sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate"), real("h", BASELINES["starter-hold7"]!())],
        { auctionType: mi % 2 ? "Vickrey" : "FirstPrice", seed: 8, matchIndex: mi, onEvent: record(ev) },
      );
      let playedLetters = 0;
      for (const e of ev) if (e.type === "word") playedLetters += e.word.length;
      const left = res.seats.reduce((a, s) => a + s.tilesLeft, 0);
      assert.equal(left + playedLetters + res.discarded, 98);
      // money: balance = 100 - spent + rewards ; score = rewards
      for (const s of res.seats) {
        let rewards = 0;
        for (const e of ev) if (e.type === "word" && e.seat === s.seat) rewards += e.reward;
        assert.equal(s.score, rewards);
        assert.equal(s.balance, 100 - s.spent + rewards);
      }
    }
  });

  test("words() runs before bid() in each auction, and bid() sees the credited balance", () => {
    const calls: string[] = [];
    let balanceAtBid1: number | undefined;
    const strat: Strategy = {
      name: "order",
      words: (v) => { calls.push(`w${v.round}`); return v.round === 1 ? ["CAT"] : []; },
      bid: (v) => { calls.push(`b${v.round}`); if (v.round === 1) balanceAtBid1 = v.myBalance; return 0; },
      onAuctionResult: (v, rec) => { calls.push(`r${v.round}:${rec.round}`); },
    };
    runMatch([real("o", strat), real("idle", bidder(0))], { auctionType: "Vickrey", bag: bagWithPrefix("CATSEDOGSIZ"), startingRackSize: 5 });
    assert.deepEqual(calls.slice(0, 7), ["w1", "b1", "r1:1", "w2", "b2", "r2:2", "w3"]);
    assert.equal(balanceAtBid1, 100 + 5); // CAT = 3+1+1, length 3 => x1, credited before bid()
  });

  test("onMatchStart is called once, before the first words()", () => {
    const calls: string[] = [];
    const strat: Strategy = {
      name: "ms",
      onMatchStart: () => calls.push("start"),
      words: () => { calls.push("w"); return []; },
      bid: () => 0,
    };
    runMatch([real("m", strat), sim("Cheapskate")], { auctionType: "Vickrey", seed: 1 });
    assert.equal(calls[0], "start");
    assert.equal(calls.filter((c) => c === "start").length, 1);
  });

  test("MatchView content: copies, public info, history", () => {
    const snaps: { round: number; hist: number[]; players: unknown[]; myBotId: number; type: string; rackSize: number; tiles: number; wordsLen: number }[] = [];
    const strat: Strategy = {
      name: "view",
      words: (v) => {
        snaps.push({
          round: v.round,
          hist: v.auctionHistory.map((r) => r.round),
          players: v.players.map((p) => [p.botId, p.isSim, p.simStrategy, p.balance, p.score]),
          myBotId: v.myBotId,
          type: v.auctionType,
          rackSize: v.startingRackSize,
          tiles: [...v.myRack.values()].reduce((a, b) => a + b, 0),
          wordsLen: v.wordHistory.length,
        });
        v.myRack.clear(); // vandalism must not leak into the engine or later views
        v.auctionHistory.length = 0;
        v.wordHistory.length = 0;
        v.players.length = 0;
        return [];
      },
      bid: () => 0,
    };
    const res = runMatch([sim("Aggressive", "Brutus-sim"), real("v", strat), sim("Cheapskate", "Cheapo-sim")], { auctionType: "FirstPrice", seed: 6 });
    assert.equal(res.seats[1]!.tilesLeft, 5); // never bid, never won
    assert.equal(snaps.length, res.auctions);
    const s6 = snaps[5]!;
    assert.equal(s6.round, 6);
    assert.deepEqual(s6.hist, [1, 2, 3, 4, 5]);
    assert.equal(s6.players.length, 3);
    assert.deepEqual((s6.players as unknown[][]).map((p) => p.slice(0, 3)), [[1, true, "Aggressive"], [2, false, undefined], [3, true, "Cheapskate"]]);
    assert.equal(s6.myBotId, 2);
    assert.equal(s6.type, "FirstPrice");
    assert.equal(s6.rackSize, 5);
    assert.equal(s6.tiles, 5);
    // public balances/scores: the Aggressive sim wins and plays words, so by round 6 someone has moved
    const first = snaps[0]!.players as unknown[][];
    assert.deepEqual(first.map((p) => [p[3], p[4]]), [[100, 0], [100, 0], [100, 0]]);
    const last = snaps[snaps.length - 1]!;
    assert.ok((last.players as unknown[][]).some((p) => (p[4] as number) > 0), "sim scores are visible to real strategies");
    assert.ok(last.wordsLen > 0, "sim word plays appear in wordHistory");
  });
});

// ---------- pricing in the engine ----------

describe("pricing end to end", () => {
  const prefix = bagWithPrefix("CATSEDOGSIZ"); // 2 players x 5, first letter Z
  test("Vickrey: pays second price; sole bidder pays 1", () => {
    const stratA = bidder((v) => (v.round === 1 ? 10 : 0));
    const stratB = bidder((v) => (v.round === 1 ? 7 : 0));
    const res = runMatch([real("a", stratA), real("b", stratB)], { auctionType: "Vickrey", bag: prefix });
    assert.equal(res.seats[0]!.balance, 93);
    assert.equal(res.seats[1]!.balance, 100);
    assert.equal(res.seats[0]!.auctionsWon, 1);
    const solo = runMatch([real("a", bidder((v) => (v.round === 1 ? 40 : 0))), real("b", bidder(0))], { auctionType: "Vickrey", bag: prefix });
    assert.equal(solo.seats[0]!.balance, 99);
  });
  test("FirstPrice: pays own bid", () => {
    const res = runMatch([real("a", bidder((v) => (v.round === 1 ? 10 : 0))), real("b", bidder((v) => (v.round === 1 ? 7 : 0)))], { auctionType: "FirstPrice", bag: prefix });
    assert.equal(res.seats[0]!.balance, 90);
    assert.equal(res.seats[1]!.balance, 100);
  });
  test("tie between real bots is random over many matches", () => {
    let a = 0;
    const N = 800;
    for (let i = 0; i < N; i++) {
      const res = runMatch([real("a", bidder((v) => (v.round === 1 ? 5 : 0))), real("b", bidder((v) => (v.round === 1 ? 5 : 0)))], { auctionType: "Vickrey", seed: 11, matchIndex: i });
      a += res.seats[0]!.auctionsWon;
      assert.equal(res.seats[0]!.auctionsWon + res.seats[1]!.auctionsWon, 1);
    }
    assert.ok(Math.abs(a / N - 0.5) < 0.07, `${a}/${N}`);
  });
  test("a bid is a bid on that auction only; zero = no bid and the letter is discarded", () => {
    const res = runMatch([real("a", bidder(0)), real("b", bidder(0))], { auctionType: "FirstPrice", bag: prefix });
    assert.equal(res.discarded, 88);
  });
});

// ---------- strategy faults are counted, never accepted ----------

describe("strategy errors", () => {
  test("invalid / unspellable words are rejected and counted; valid ones are credited", () => {
    const ev: EngineEvent[] = [];
    const strat: Strategy = {
      name: "bad",
      words: (v) => (v.round === 1 ? ["ZZZZ", "A", "QUA", "cat", "CAT", "TEXT", "C@T"] : []),
      bid: () => 0,
    };
    const res = runMatch([real("bad", strat), real("idle", bidder(0))], {
      auctionType: "Vickrey", bag: bagWithPrefix("CATSEDOGSIZ"), onEvent: record(ev),
    });
    const s = res.seats[0]!;
    // ZZZZ (not in dict), A (<2), C@T (format) => invalid 3 ; QUA (no Q), second CAT (tiles used), TEXT (no X) => unspellable 3
    assert.equal(s.errors.invalidWords, 3);
    assert.equal(s.errors.unspellableWords, 3);
    assert.equal(s.score, 5); // only the first "cat" counted
    assert.equal(s.balance, 105);
    assert.equal(s.tilesLeft, 2);
    assert.equal(s.wordsPlayed, 1);
    assert.equal(ev.filter((e) => e.type === "reject").length, 6);
  });

  test("words are applied sequentially: two words from one rack succeed only if tiles suffice", () => {
    const strat = bidder(0, (v) => (v.round === 1 ? ["AT", "SEC"] : []));
    // rack CATSE: AT uses A,T ; SEC uses S,E,C => all five tiles
    const res = runMatch([real("p", strat), real("q", bidder(0))], { auctionType: "Vickrey", bag: bagWithPrefix("CATSEDOGSIZ") });
    assert.equal(res.seats[0]!.errors.unspellableWords, 0);
    assert.equal(res.seats[0]!.wordsPlayed, 2);
    assert.equal(res.seats[0]!.tilesLeft, 0);
    assert.equal(res.seats[0]!.score, 2 + 5); // AT=2, SEC=1+1+3=5
  });

  test("bids above the balance are counted and treated as 0; malformed bids too", () => {
    const strat = bidder((v) => (v.round === 1 ? 101 : v.round === 2 ? Number.NaN : v.round === 3 ? -4 : v.round === 4 ? 2.5 : v.round === 5 ? 100 : 0));
    const res = runMatch([real("e", strat), real("idle", bidder(0))], { auctionType: "FirstPrice", seed: 1 });
    const s = res.seats[0]!;
    assert.equal(s.errors.overBalanceBids, 1); // 101 > 100
    assert.equal(s.errors.badBids, 3); // NaN, -4, 2.5
    assert.equal(s.auctionsWon, 1); // the legal 100-bid in round 5 is accepted (balance == bid) and wins
    assert.equal(s.balance, 0);
    assert.equal(s.spent, 100);
  });

  test("a throwing strategy is contained and counted", () => {
    const strat: Strategy = { name: "boom", words: () => { throw new Error("kaput"); }, bid: () => { throw new Error("kaput2"); } };
    const res = runMatch([real("boom", strat), sim("Cheapskate")], { auctionType: "Vickrey", seed: 1 });
    assert.equal(res.seats[0]!.errors.exceptions, 2 * res.auctions);
    assert.equal(res.seats[0]!.errors.firstError, "kaput");
    const nonArray = runMatch([real("n", { name: "n", words: () => "CAT" as unknown as string[], bid: () => 0 }), sim("Cheapskate")], { auctionType: "Vickrey", seed: 1 });
    assert.equal(nonArray.seats[0]!.errors.badReturns, nonArray.auctions);
  });

  test("Math.random inside strategies is seeded (deterministic) and restored afterwards", () => {
    const original = Math.random;
    const mk = (): Strategy => ({ name: "rnd", words: () => [], bid: () => Math.floor(Math.random() * 8) });
    const run = () => runMatch([real("r", mk()), sim("ValueBidder")], { auctionType: "Vickrey", seed: 21, matchIndex: 3 });
    const a = run();
    const b = run();
    assert.deepEqual(a.seats.map((s) => [s.score, s.balance, s.auctionsWon]), b.seats.map((s) => [s.score, s.balance, s.auctionsWon]));
    assert.equal(Math.random, original);
    // a different match index gives different randomness
    const c = runMatch([real("r", mk()), sim("ValueBidder")], { auctionType: "Vickrey", seed: 21, matchIndex: 4 });
    assert.notDeepEqual(a.seats.map((s) => s.balance), c.seats.map((s) => s.balance));
  });
});

// ---------- sim word play ----------

describe("sim winners play findBestPlayable(rack, 3) immediately", () => {
  test("every sim word equals the reference scan on the rack at that moment", () => {
    let simWords = 0;
    for (let mi = 0; mi < 15; mi++) {
      const ev: EngineEvent[] = [];
      runMatch([sim("Aggressive"), sim("ValueBidder"), sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate"), sim("Aggressive")], {
        auctionType: mi % 2 ? "Vickrey" : "FirstPrice", seed: 31, matchIndex: mi, onEvent: record(ev),
      });
      // replay racks
      const racks = new Map<number, Map<string, number>>();
      let pending: { seat: number; expected: string } | null = null;
      for (const e of ev) {
        if (e.type === "deal") {
          const m = new Map<string, number>();
          for (const c of e.letters) m.set(c, (m.get(c) ?? 0) + 1);
          racks.set(e.seat, m);
        } else if (e.type === "open" || e.type === "end") {
          assert.equal(pending, null, "a sim with a playable word must play before the next letter opens");
        } else if (e.type === "close") {
          if (e.received) {
            const r = racks.get(e.winnerSeat)!;
            r.set(e.letter, (r.get(e.letter) ?? 0) + 1);
            const expected = findBestPlayableRef(r, 3);
            pending = expected === undefined ? null : { seat: e.winnerSeat, expected };
          }
        } else if (e.type === "word") {
          assert.ok(pending, "word without a preceding sim win");
          assert.equal(e.by, "sim");
          assert.equal(e.seat, pending.seat);
          assert.equal(e.word, pending.expected);
          assert.equal(e.reward, wordReward(e.word));
          const r = racks.get(e.seat)!;
          for (const c of e.word) r.set(c, r.get(c)! - 1);
          pending = null;
          simWords++;
        }
      }
    }
    assert.ok(simWords > 100, `only ${simWords} sim words observed`);
  });

  test("real strategies' words land in the words() phase (before bids); sim words only after a sim win closes", () => {
    let real_ = 0;
    let sim_ = 0;
    for (let mi = 0; mi < 10; mi++) {
      const ev: EngineEvent[] = [];
      runMatch([sim("Aggressive"), real("s", BASELINES["starter"]!()), sim("ValueBidder"), real("v", BASELINES["value-plus"]!()), sim("Cheapskate"), sim("Aggressive")], {
        auctionType: "Vickrey", seed: 52, matchIndex: mi, onEvent: record(ev),
      });
      let phase: "words" | "closing" = "words";
      let lastWinner = -1;
      for (const e of ev) {
        if (e.type === "open") phase = "words";
        else if (e.type === "bids") phase = "closing";
        else if (e.type === "close") lastWinner = e.received ? e.winnerSeat : -1;
        else if (e.type === "word") {
          if (e.by === "real") {
            assert.equal(phase, "words");
            assert.ok(e.seat === 1 || e.seat === 3);
            real_++;
          } else {
            assert.equal(phase, "closing");
            assert.equal(e.seat, lastWinner, "sim words only by the sim that just won");
            sim_++;
          }
        }
      }
    }
    assert.ok(real_ > 0 && sim_ > 0);
  });

  test("the auction opened with bagRemaining == 0 still lets a sim winner play, then the match ends", () => {
    let proven = false;
    for (let mi = 0; mi < 400 && !proven; mi++) {
      const ev: EngineEvent[] = [];
      runMatch([sim("Aggressive"), real("idle", bidder(0))], { auctionType: "Vickrey", seed: 41, matchIndex: mi, onEvent: record(ev) });
      const n = ev.length;
      assert.equal(ev[n - 1]!.type, "end");
      // find last close and see whether a word follows it
      const lastCloseIdx = ev.map((e) => e.type).lastIndexOf("close");
      const close = ev[lastCloseIdx] as Extract<EngineEvent, { type: "close" }>;
      assert.equal(close.round, 88);
      const after = ev.slice(lastCloseIdx + 1);
      if (after.length === 2 && after[0]!.type === "word") {
        assert.equal((after[0] as Extract<EngineEvent, { type: "word" }>).round, 88);
        proven = true;
      }
    }
    assert.ok(proven, "never observed a sim word in the final auction");
  });

  test("a real winner of the final letter cannot use it (match is over); its words() on the last auction still count", () => {
    const strat = bidder(
      (v) => (v.bagRemaining === 0 ? 50 : 0),
      (v) => (v.bagRemaining === 0 ? ["CAT"] : []),
    );
    const res = runMatch([real("last", strat), real("idle", bidder(0))], { auctionType: "Vickrey", bag: bagWithPrefix("CATSEDOGSI"), seed: 1 });
    assert.equal(res.seats[0]!.score, 5);
    assert.equal(res.seats[0]!.auctionsWon, 1);
    assert.equal(res.seats[0]!.tilesLeft, 5 - 3 + 1);
  });
});

// ---------- bag, determinism, common random numbers ----------

describe("bag, determinism and common random numbers", () => {
  test("makeBag is a permutation of the 98 tiles, keyed by (seed, match)", () => {
    const a = makeBag(7, 0);
    const b = makeBag(7, 0);
    const c = makeBag(7, 1);
    const d = makeBag(8, 0);
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.notDeepEqual(Array.from(a), Array.from(c));
    assert.notDeepEqual(Array.from(a), Array.from(d));
    assert.deepEqual(Array.from(a).sort((x, y) => x - y), Array.from(fullBagIndices()).sort((x, y) => x - y));
  });

  test("first-tile frequencies match the bag distribution (uniform draw over tiles)", () => {
    const N = 20000;
    const counts = new Array<number>(26).fill(0);
    for (let i = 0; i < N; i++) counts[makeBag(1234, i)[0]!]!++;
    for (const [letter, n] of DEFAULT_BAG) {
      const p = n / 98;
      const got = counts[letterIndex(letter)]! / N;
      assert.ok(Math.abs(got - p) < 5 * Math.sqrt((p * (1 - p)) / N), `${letter}: ${got} vs ${p}`);
    }
  });

  test("same seed => identical letters for different strategies; round-1 sim bids identical", () => {
    const run = (strategy: Strategy) => {
      const ev: EngineEvent[] = [];
      runMatch([real("t", strategy), sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate"), sim("Aggressive"), sim("Cheapskate")], { auctionType: "Vickrey", seed: 99, matchIndex: 17, onEvent: record(ev) });
      return ev;
    };
    const a = run(BASELINES["starter"]!());
    const b = run(BASELINES["value-plus"]!());
    const letters = (ev: EngineEvent[]) => ev.filter((e) => e.type === "open").map((e) => (e as Extract<EngineEvent, { type: "open" }>).letter).join("");
    // bag order is fixed; discards do not change what is drawn next
    assert.equal(letters(a), letters(b));
    assert.deepEqual(a.filter((e) => e.type === "deal"), b.filter((e) => e.type === "deal"));
    const simBids = (ev: EngineEvent[]) => (ev.find((e) => e.type === "bids" && e.round === 1) as Extract<EngineEvent, { type: "bids" }>).bids.filter((x) => x.source === "sim");
    assert.deepEqual(simBids(a), simBids(b));
  });

  test("a full run is bit-for-bit reproducible", () => {
    const run = () =>
      runMatch([real("s", BASELINES["starter"]!()), sim("Aggressive"), sim("Aggressive"), real("h", BASELINES["starter-hold7"]!()), sim("ValueBidder"), real("v", BASELINES["value-plus"]!())], { auctionType: "FirstPrice", seed: 5, matchIndex: 9 })
        .seats.map((s) => [s.name, s.score, s.balance, s.place, s.auctionsWon, s.wordsPlayed]);
    assert.deepEqual(run(), run());
  });
});

// ---------- differential test against a deliberately literal re-implementation ----------

describe("differential: engine vs literal game.ts-style port (all-sim matches)", () => {
  type Tag = SimStrategyTag;
  /** Literal port of startMatchWith/closeAuction/simulateBids for sim-only matches, using the server's data flow:
   *  bag counts walked in A-Z order for a uniform index, bids shuffled then stable-sorted, bigint money. */
  function literalSimMatch(tags: Tag[], type: "Vickrey" | "FirstPrice", rng: () => number) {
    const counts = new Map<string, number>(DEFAULT_BAG.map(([l, n]) => [l, n]));
    let bagTotal = 98;
    const draw = (): string | undefined => {
      if (bagTotal === 0) return undefined;
      let idx = Math.floor(rng() * bagTotal);
      for (const [letter, rem] of [...counts].filter(([, r]) => r > 0).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (idx < rem) {
          counts.set(letter, rem - 1);
          bagTotal--;
          return letter;
        }
        idx -= rem;
      }
      return undefined;
    };
    const racks = tags.map(() => new Map<string, number>());
    const balance = tags.map(() => 100n);
    const score = tags.map(() => 0n);
    const words = tags.map(() => 0);
    let discarded = 0;
    for (let i = 0; i < tags.length; i++) for (let n = 0; n < 5; n++) { const l = draw()!; racks[i]!.set(l, (racks[i]!.get(l) ?? 0) + 1); }
    let letter = draw()!;
    for (;;) {
      const bids: { i: number; amount: bigint }[] = [];
      for (let i = 0; i < tags.length; i++) {
        const jitter = BigInt(-2 + Math.floor(rng() * 5));
        const value = BigInt(letterValue(letter));
        const base = tags[i] === "Cheapskate" ? value - 1n : tags[i] === "ValueBidder" ? value : value + ("AEIOU".includes(letter) ? 4n : 2n);
        let amt = base + jitter;
        if (amt < 1n) amt = 1n;
        if (amt > balance[i]!) amt = balance[i]!;
        if (amt < 0n) amt = 0n;
        if (amt > 0n) bids.push({ i, amount: amt });
      }
      const sorted = bids.filter((b) => b.amount > 0n);
      for (let k = sorted.length - 1; k >= 1; k--) { const j = Math.floor(rng() * (k + 1)); [sorted[k], sorted[j]] = [sorted[j]!, sorted[k]!]; }
      sorted.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
      const [first, second] = sorted;
      let winner: number | undefined;
      if (first) {
        winner = first.i;
        const paid = type === "FirstPrice" ? first.amount : second ? second.amount : first.amount < 1n ? first.amount : 1n;
        if (balance[winner]! >= paid) {
          balance[winner]! -= paid;
          racks[winner]!.set(letter, (racks[winner]!.get(letter) ?? 0) + 1);
          const w = findBestPlayable(racks[winner]!, 3);
          if (w !== undefined) {
            for (const c of w) racks[winner]!.set(c, racks[winner]!.get(c)! - 1);
            const r = BigInt(wordReward(w));
            balance[winner]! += r;
            score[winner]! += r;
            words[winner]!++;
          }
        } else discarded++;
      } else discarded++;
      const next = draw();
      if (next === undefined) break;
      letter = next;
    }
    return { score: score.map(Number), balance: balance.map(Number), words, discarded };
  }

  for (const type of ["Vickrey", "FirstPrice"] as const) {
    test(`${type}: per-strategy means of score, final balance and words agree within sampling error`, () => {
      const tags: Tag[] = ["Cheapskate", "ValueBidder", "Aggressive", "Cheapskate", "ValueBidder", "Aggressive"];
      const N = 1500;
      const acc = (label: string) => ({ label, a: [] as number[][], b: [] as number[][] });
      const stats = { score: acc("score"), balance: acc("balance"), words: acc("words") };
      const rng = mulberry32(555);
      for (let mi = 0; mi < N; mi++) {
        const lit = literalSimMatch(tags, type, rng);
        stats.score.a.push(lit.score); stats.balance.a.push(lit.balance); stats.words.a.push(lit.words);
        const res = runMatch(tags.map((t, i) => sim(t, `s${i}`)), { auctionType: type, seed: 777, matchIndex: mi });
        stats.score.b.push(res.seats.map((x) => x.score));
        stats.balance.b.push(res.seats.map((x) => x.balance));
        stats.words.b.push(res.seats.map((x) => x.wordsPlayed));
      }
      const meanSe = (xs: number[]) => {
        const m = xs.reduce((a, b) => a + b, 0) / xs.length;
        const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
        return [m, Math.sqrt(v / xs.length)] as const;
      };
      for (const st of Object.values(stats)) {
        for (let seat = 0; seat < 6; seat++) {
          const [ma, sa] = meanSe(st.a.map((r) => r[seat]!));
          const [mb, sb] = meanSe(st.b.map((r) => r[seat]!));
          const z = (ma - mb) / Math.sqrt(sa * sa + sb * sb);
          assert.ok(Math.abs(z) < 4, `${type} ${st.label} seat ${seat} (${tags[seat]}): literal ${ma.toFixed(2)} vs engine ${mb.toFixed(2)}, z=${z.toFixed(2)}`);
        }
      }
    });
  }
});

// ---------- results: place / swiss / win ----------

describe("ranking", () => {
  test("ties share the better place; swiss = players - place; wins shared", () => {
    const res = runMatch([real("a", bidder(0)), real("b", bidder(0)), real("c", bidder(0))], { auctionType: "Vickrey", seed: 1 });
    assert.deepEqual(res.seats.map((s) => [s.place, s.swiss, s.win]), [[1, 2, true], [1, 2, true], [1, 2, true]]);
  });
  test("distinct scores rank 1..n and tied lower places share", () => {
    // seat0 plays CAT (5), seat1 plays AT (2), seat2 and seat3 play nothing (0, tied for 3rd)
    const res = runMatch(
      [real("a", bidder(0, (v) => (v.round === 1 ? ["CAT"] : []))), real("b", bidder(0, (v) => (v.round === 1 ? ["AT"] : []))), real("c", bidder(0)), real("d", bidder(0))],
      { auctionType: "Vickrey", bag: bagWithPrefix("CATSEATSEDOGSIBIRDNE") },
    );
    assert.deepEqual(res.seats.map((s) => [s.score, s.place, s.swiss]), [[5, 1, 3], [2, 2, 2], [0, 3, 1], [0, 3, 1]]);
  });
});

// ---------- registry and harness ----------

describe("registry and harness", () => {
  test("built-in strategies load and obey the Strategy contract", async () => {
    const reg = await loadRegistry();
    for (const n of ["starter", "starter-hold7", "value-plus"]) {
      const e = reg.entries.get(n)!;
      assert.ok(e, n);
      const s = e.factory();
      assert.equal(typeof s.words, "function");
      assert.equal(typeof s.bid, "function");
    }
  });

  test("auto-load: createStrategy (name = filename) and STRATEGIES tables; broken/helper/index/_files skipped", async () => {
    const reg = await loadRegistry([{ dir: new URL("./fixtures/strat/", import.meta.url), source: "models" }]);
    assert.deepEqual([...reg.entries.keys()].sort(), ["alpha", "multi-a", "multi-b", "starter", "starter-hold7", "value-plus"]);
    assert.equal(reg.entries.get("alpha")!.source, "models");
    assert.equal(reg.entries.get("multi-b")!.factory().bid({} as MatchView, "A"), 3);
    assert.equal(reg.loadErrors.length, 1);
    assert.match(reg.loadErrors[0]!.file, /broken\.ts/);
    // a registered model strategy is usable as a test strategy and as a "mixed" opponent
    const r = runBatch({ tests: ["starter"], field: "mixed", matches: 40, seed: 1, auctionType: "Vickrey", players: 6, rack: 5, maxSeconds: 30, showField: true, registry: reg });
    const used = new Set(r.opponentsUsed);
    assert.ok(used.has("alpha") || used.has("multi-a") || used.has("multi-b"), "models appear in the mixed pool");
    assert.ok(!used.has("starter"), "the strategy under test is not its own opponent");
  });

  test("upstream golden rewards (spacetimedb/src/tests/words.test.ts)", () => {
    for (const [w, total] of [["QUIZ", 33], ["AXES", 16], ["QUAKE", 36], ["ZEBRAS", 42], ["JUKEBOX", 81], ["CAT", 5]] as const) {
      assert.equal(wordReward(w), total, w);
    }
  });

  test("baselines behave as specified", () => {
    const view = (rack: Record<string, number>, over: Partial<MatchView> = {}): MatchView => ({
      matchId: 1, myBotId: 1, auctionType: "Vickrey", auctionDurationMs: 1000, startingRackSize: 5, players: [],
      myRack: new Map(Object.entries(rack)), myBalance: 100, myScore: 0, round: 1, bagRemaining: 50, auctionHistory: [], wordHistory: [], ...over,
    });
    const starter = BASELINES["starter"]!();
    assert.equal(starter.bid(view({}), "Q"), 12); // value 10 + 2 (hold none)
    assert.equal(starter.bid(view({ Q: 1 }), "Q"), 10); // already hold one: face value
    assert.equal(starter.bid(view({ E: 1 }), "E"), 1);
    assert.equal(starter.bid(view({}, { myBalance: 4 }), "Q"), 4); // clamp
    assert.deepEqual(starter.words(view({ C: 1, A: 1, T: 1 })), ["ACT"]); // ACT < CAT: lexicographically first of the 3-letter anagrams
    assert.deepEqual(starter.words(view({ Z: 1, Q: 1 })), []);
    const hold = BASELINES["starter-hold7"]!();
    assert.deepEqual(hold.words(view({ C: 1, A: 1, T: 1, S: 1, E: 1 })), []); // 5 letters, holds out
    assert.deepEqual(hold.words(view({ C: 1, A: 1, T: 1, S: 1, E: 1 }, { bagRemaining: 0 })), ["CASTE"]); // dumps on the last auction; CASTE is the first 5-letter anagram
    const vp = BASELINES["value-plus"]!();
    assert.equal(vp.bid(view({}), "Q"), 13);
    assert.equal(vp.bid(view({}, { myBalance: 6 }), "Q"), 6);
    assert.deepEqual(vp.words(view({ C: 1, A: 1, T: 1 })), []); // < 5 letters
    assert.deepEqual(vp.words(view({ C: 1, A: 1, T: 1, S: 1, E: 1 })), ["CASTE"]);
  });

  test("duplicate matches: identical strategies get identical results (paired difference exactly 0)", async () => {
    const reg = await loadRegistry();
    const base = reg.entries.get("value-plus")!;
    const registry: Registry = { entries: new Map(reg.entries), loadErrors: [] };
    registry.entries.set("value-plus-copy", { ...base, name: "value-plus-copy" });
    const cfg = { tests: ["value-plus", "value-plus-copy"], field: "lobby-sims", matches: 30, seed: 3, auctionType: "Vickrey" as const, players: 6, rack: 5, maxSeconds: 60, showField: false, registry };
    const r = runBatch(cfg);
    assert.equal(r.paired[0]!.dScore.mean, 0);
    assert.equal(r.paired[0]!.dScore.se, 0);
    assert.equal(r.strategies[0]!.score.mean, r.strategies[1]!.score.mean);
    const r2 = runBatch(cfg);
    assert.deepEqual(r.strategies.map((s) => s.score), r2.strategies.map((s) => s.score));
    assert.equal(r.matchesCompleted, 30);
  });

  test("fields: lobby-sims draws 5 distinct sims; starters; field:list; self rotates seats", async () => {
    const registry = await loadRegistry();
    const common = { matches: 12, seed: 2, auctionType: "FirstPrice" as const, players: 6, rack: 5, maxSeconds: 60, registry };
    const lobby = runBatch({ ...common, tests: ["starter"], field: "lobby-sims", showField: true });
    assert.equal(lobby.strategies.filter((s) => s.role === "field").every((s) => s.name.endsWith("-sim")), true);
    const names = lobby.strategies.filter((s) => s.role === "field").map((s) => s.name);
    assert.ok(names.length >= 5 && names.length <= 6);
    // distinct: each sim appears at most once per match => n per sim <= matches
    assert.ok(lobby.strategies.filter((s) => s.role === "field").every((s) => s.n <= 12));
    const starters = runBatch({ ...common, tests: ["value-plus"], field: "starters", showField: true });
    const starterRows = starters.strategies.filter((s) => s.role === "field");
    assert.equal(starterRows.length, 1);
    assert.equal(starterRows[0]!.name, "starter");
    const explicit = runBatch({ ...common, tests: ["value-plus"], field: "field:Brutus-sim,Cheapskate,starter", showField: true });
    assert.deepEqual(explicit.opponentsUsed, ["Brutus-sim", "sim:Cheapskate", "starter"].sort());
    const self = runBatch({ ...common, tests: ["starter", "value-plus"], field: "self", showField: false });
    assert.equal(self.strategies.length, 2);
    assert.equal(self.strategies[0]!.n, 12);
    assert.ok(self.strategies.every((x) => x.place.mean >= 1 && x.place.mean <= 6));
  });

  test("time limit stops cleanly with a consistent number of matches for every test", async () => {
    const registry = await loadRegistry();
    const r = runBatch({ tests: ["starter", "value-plus"], field: "lobby-sims", matches: 1_000_000, seed: 1, auctionType: "Vickrey", players: 6, rack: 5, maxSeconds: 0.3, showField: false, registry });
    assert.equal(r.truncated, true);
    assert.equal(r.strategies[0]!.n, r.strategies[1]!.n);
    assert.equal(r.strategies[0]!.n, r.matchesCompleted);
  });

  test("speed: >= 30 six-player matches/second with baseline strategies", async () => {
    const registry = await loadRegistry();
    const r = runBatch({ tests: ["starter", "starter-hold7", "value-plus"], field: "mixed", matches: 60, seed: 1, auctionType: "Vickrey", players: 6, rack: 5, maxSeconds: 60, showField: false, registry });
    assert.ok(r.runsPerSecond >= 30, `only ${r.runsPerSecond.toFixed(1)} matches/s`);
  });
});
