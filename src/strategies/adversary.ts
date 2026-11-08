// "adversary": a bot built to hurt the leader ("tuned") and pick up the placement points.
//
// Engine: the leader's own valuation (tuned) supplies my base bid and my word play, so I compete for the same tiles on
// equal terms. On top of that I run an attack layer against one TARGET opponent (the best other seat by score + cash):
//   1. Rack reconstruction: target rack ~ (tiles it won) - (tiles it played). Its unknown 5-tile start is ignored.
//   2. DENIAL / SNIPE: if the reconstructed rack is exactly one tile short of a 7+ word (W.minMissing), that tile is the
//      letter the leader's "word architect" boost pays up for. I bid above my estimate of its bid so I win it and the
//      leader pays nothing and loses the 3x word multiplier. In Vickrey I pay only its own (high) bid.
//   3. PRICE PUSH (Vickrey only): on other letters I add a shadow bid just under my estimate of the target's bid. If the
//      target wins, it pays my shadow bid, so its cash drains (its pace term then cuts its later bids). If I win by
//      accident I pay the target's bid for a letter I scored as valuable-enough (shadow is capped, only placed when the
//      engine already wants the letter at >= pushMinFrac of the shadow).
// All knobs can be overridden at runtime with env ADV='{"deny":1.3,...}' (used for sweeps, unset in production).

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createStrategy as createTuned } from "./tuned.js";

export interface AdvParams {
  deny: number; // snipe bid = deny * estimated target bid for its completion letter (0 = off)
  denyCapFrac: number; // max share of my balance for a snipe
  denyMinReward: number; // only deny when the target's best 7+ word is worth at least this
  push: number; // shadow bid = push * estimated target bid (0 = off)
  pushCapFrac: number; // max share of my balance for a shadow bid
  pushMinFrac: number; // only push when my engine bid >= this fraction of the shadow
  pushUntilBag: number; // stop pushing in the last N auctions (my own endgame matters)
  tmult: number; // target top bid vs market clearing price
  archBoost: number; // target bid multiplier on its completion letter
  startRound: number; // do not attack before this round
}

export const ADV_DEFAULTS: AdvParams = {
  deny: 1.25,
  denyCapFrac: 0.4,
  denyMinReward: 18,
  push: 0.9,
  pushCapFrac: 0.2,
  pushMinFrac: 0.5,
  pushUntilBag: 6,
  tmult: 1.3,
  archBoost: 1.4,
  startRound: 6,
};

// Table-size profiles. Heads-up (the final): I am always the other bidder, so my bid IS the price the leader pays when it
// wins; bidding the going rate on everything I plausibly want drains it and wins tiles at its low (prior-based) price.
// Measured +60-70 points/game vs tuned heads-up. At 4+ players the same push only overpays (-4.7 pts, 0 damage), so it is off.
export const BY_PLAYERS: Record<number, Partial<AdvParams>> = {
  2: { push: 1.0, tmult: 1.0, pushCapFrac: 0.3, pushMinFrac: 0.3, deny: 0 },
};
const DBG = { deny: 0, denyRaised: 0, push: 0, bids: 0 };
if (process.env.ADV_DEBUG) process.on("exit", () => console.error("[adversary dbg]", JSON.stringify(DBG)));
const A = 65;
const shape = (v: number, li: number): number => {
  const s = 0.77 + 0.215 * v;
  return li === 16 ? s * 0.66 : s;
};

export function createStrategy(overrides?: Partial<AdvParams>): Strategy {
  const base = createTuned();
  let envOv: Partial<AdvParams> = {};
  try {
    if (process.env.ADV) envOv = JSON.parse(process.env.ADV) as Partial<AdvParams>;
  } catch {
    envOv = {};
  }
  const userOv = typeof overrides === "object" && overrides ? overrides : {};
  const pcache = new Map<number, AdvParams>();
  function paramsFor(n: number): AdvParams {
    let q = pcache.get(n);
    if (!q) {
      q = { ...ADV_DEFAULTS, push: 0, ...(BY_PLAYERS[n] ?? {}), ...userOv, ...envOv };
      pcache.set(n, q);
    }
    return q;
  }
  let P: AdvParams = paramsFor(6);

  let matchId = -1;
  let seen = 0;
  let level = 1; // market clearing price / shape(value), EMA
  let nObs = 0;
  let mmKey = "";
  let mmVal: W.MinMissingResult | null = null;

  function sync(view: MatchView): void {
    if (view.matchId !== matchId) {
      matchId = view.matchId;
      seen = 0;
      level = 1;
      nObs = 0;
      mmKey = "";
      mmVal = null;
    }
    const hist = view.auctionHistory;
    if (seen > hist.length) seen = 0;
    while (seen < hist.length) {
      const rec: AuctionRecord = hist[seen++]!;
      if (rec.winnerBotId === null) continue;
      const li = rec.letter.charCodeAt(0) - A;
      if (li < 0 || li > 25) continue;
      const v = W.LETTER_VALUES[li]!;
      const ratio = rec.paid / shape(v, li);
      const k = nObs++;
      const a = Math.max(0.12, 1 / (k + 4));
      level = k === 0 ? ratio : level + a * (Math.min(6 * 4, ratio) - level);
    }
  }

  function pickTarget(view: MatchView): number | null {
    let best: number | null = null;
    let bestKey = -1e9;
    for (const p of view.players) {
      if (p.botId === view.myBotId) continue;
      const key = p.score + 0.5 * p.balance;
      if (key > bestKey) {
        bestKey = key;
        best = p.botId;
      }
    }
    return best;
  }

  function targetRack(view: MatchView, tid: number): W.Counts {
    const c = new Int32Array(26);
    for (const a of view.auctionHistory) {
      if (a.winnerBotId === tid) {
        const li = a.letter.charCodeAt(0) - A;
        if (li >= 0 && li < 26) c[li]!++;
      }
    }
    for (const w of view.wordHistory) {
      if (w.botId !== tid) continue;
      for (let i = 0; i < w.word.length; i++) {
        const li = w.word.charCodeAt(i) - A;
        if (li >= 0 && li < 26 && c[li]! > 0) c[li]!--;
      }
    }
    return Uint8Array.from(c, (x) => Math.max(0, Math.min(255, x)));
  }

  return {
    name: "adversary",
    onMatchStart: (v) => base.onMatchStart?.(v),
    onAuctionResult: (v, r) => base.onAuctionResult?.(v, r),
    words: (v) => base.words(v),

    bid(view: MatchView, letter: string): number {
      const eng = base.bid(view, letter);
      P = paramsFor(view.players.length);
      DBG.bids++;
      sync(view);
      const bal = Math.floor(view.myBalance);
      const li = letter.charCodeAt(0) - A;
      if (view.bagRemaining <= P.pushUntilBag || bal < 2 || li < 0 || li > 25 || view.round < P.startRound) return eng;
      const tid = pickTarget(view);
      if (tid === null) return eng;
      const tp = view.players.find((p) => p.botId === tid)!;
      if (tp.balance < 3) return eng; // nothing left to drain, nothing to deny

      const v = W.LETTER_VALUES[li]!;
      const market = level * shape(v, li);
      // the target is cash-paced: a poorer target bids less
      const paceT = Math.min(1.5, Math.max(0.55, Math.pow(Math.max(0.05, tp.balance) / Math.max(8, 100 * (1 - 0.95 * (view.round / (view.round + view.bagRemaining)))), 0.8)));
      let tBid = market * P.tmult * paceT;
      let out = eng;

      // 1. denial / snipe on the target's completion letter
      if (P.deny > 0) {
        const tr = targetRack(view, tid);
        const tiles = W.totalTiles(tr);
        if (tiles >= 4) {
          const key = W.countsKey(tr);
          if (key !== mmKey || !mmVal) {
            mmVal = W.minMissing(tr, { minLen: 7 });
            mmKey = key;
          }
          if (mmVal.missing === 1 && mmVal.letterWords[li]! > 0 && mmVal.bestReward >= P.denyMinReward) {
            const worth = 0.5 + 0.5 * Math.min(1, mmVal.bestReward / 40);
            tBid *= 1 + (P.archBoost - 1) * worth;
            const snipe = Math.min(Math.round(P.deny * tBid), Math.floor(P.denyCapFrac * bal), Math.round(0.7 * mmVal.bestReward));
            DBG.deny++;
            if (snipe > out) { out = snipe; DBG.denyRaised++; }
            return Math.max(0, Math.min(bal, out));
          }
        }
      }

      // 2. price push: shadow bid just under the target's expected bid (Vickrey only; in FirstPrice it just overpays)
      if (P.push > 0 && view.auctionType === "Vickrey") {
        const shadow = Math.min(Math.round(P.push * tBid), Math.floor(P.pushCapFrac * bal));
        if (shadow > out && eng >= P.pushMinFrac * shadow) { out = shadow; DBG.push++; }
      }
      return Math.max(0, Math.min(bal, out));
    },
  };
}

export default createStrategy;
