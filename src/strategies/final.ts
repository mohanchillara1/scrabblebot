// "final": the tournament entry. A stage-adaptive dispatcher.
//
//   * tables with >= 3 players (Swiss, bracket)  -> economist engine (live-best on the real 6-player field)
//                                                   + late-game cash burn (Vickrey, >= 5 players)
//   * heads-up (exactly 2 players, the final)    -> adversary (tuned engine + going-rate bid rule), which beat tuned,
//                                                   topbot-like, mcvalue and economist heads-up in the sim
//   * every match gets its OWN fresh sub-strategy instance (keyed by matchId); no state crosses matches.
//   * all sub-strategies are wrapped: exceptions -> {no words, bid 0}; words validated; bids clamped to the balance.
//   * endgame: the whole rack is dumped when bagRemaining <= dumpAt (default 1), one auction before the last one,
//     so a stalled server / burst of closing auctions cannot cost the big last-auction dump ("Match not running").
//   * createStrategy() warms the dictionary and JIT-compiles the hot paths on synthetic matches.
//
// Tuning / A-B in the simulator: env FINAL='{"burn":false,"dumpAt":0,"hu":"tuned"}' overrides the config for every
// instance (unset in production). Named variants are registered through STRATEGIES (fin-*).

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createStrategy as createAdversary, type AdvParams } from "./adversary.js";
import { createEconomist as createEconomistP, type EconParams } from "./economist.js";
const createEconomist = (p: Partial<EconParams> = {}): Strategy => createEconomistP(p);
import { createStrategy as createMcvalue } from "./mcvalue.js";
import { createStrategy as createTuned } from "./tuned.js";
import { BURN_DEFAULTS, burnBid, type BurnParams } from "./final/burn.js";

export type RuleName = "economist" | "tuned" | "adversary" | "advR" | "mcvalue";

export interface FinalConfig {
  multi: RuleName; // rule for tables with >= 3 players
  hu: RuleName; // rule for heads-up (2 players), Vickrey
  huFP: RuleName; // rule for heads-up (2 players), FirstPrice (the adversary's push is Vickrey-only, so it adds nothing there)
  burn: boolean; // late-game cash floor for the multi-player rule
  burnParams: Partial<BurnParams>;
  dumpAt: number; // dump the whole rack when 0 < bagRemaining <= dumpAt (0 = only the last auction, via the sub-strategy)
  dumpBudgetMs: number;
  econ?: Partial<EconParams>; // overrides for every economist instance
  adv?: Partial<AdvParams>; // overrides for the robust adversary (advR)
  byPlayers?: Record<string, RuleName>; // per table size rule for >= 3 players (falls back to multi)
  burnRules?: RuleName[]; // rules that get the late cash burn (default: just multi)
}

export const FINAL_DEFAULTS: FinalConfig = {
  multi: "economist",
  hu: "advR",
  huFP: "economist",
  burn: true,
  burnParams: {},
  dumpAt: 1,
  dumpBudgetMs: 30,
};

const ADV_ROBUST = { pushCapFrac: 0.7, pushMinFrac: 0.15 };

function makeRule(rule: RuleName, cfg: FinalConfig): Strategy {
  if (rule === "economist") return createEconomist(cfg.econ ?? {});
  if (rule === "advR") return createAdversary({ ...ADV_ROBUST, ...(cfg.adv ?? {}) });
  return FACTORIES[rule]();
}

const FACTORIES: Record<RuleName, () => Strategy> = {
  economist: () => createEconomist(),
  tuned: () => createTuned(),
  adversary: () => createAdversary(),
  // adversary with a larger shadow-bid cap (70% of balance): beats the default adversary in self-play (+12 pp win, n=400),
  // and is at least as good against tuned / topbot-like / economist (docs/FINAL.md). The default cap (30%) is exploitable.
  advR: () => createAdversary(ADV_ROBUST),
  mcvalue: () => createMcvalue(),
};

function rackTotal(rack: Map<string, number>): number {
  let t = 0;
  for (const n of rack.values()) t += n;
  return t;
}

/** Longest-first optimal partition of the whole rack, validated (dictionary + spellable in sequence). */
function dumpWords(view: MatchView, budgetMs: number): string[] {
  if (rackTotal(view.myRack) < 2) return [];
  let R = W.rackToCounts(view.myRack);
  const part = W.bestPartition(R, { timeBudgetMs: budgetMs });
  const out: string[] = [];
  for (const w of part.words) {
    if (W.isWord(w) && W.canSpell(R, w)) {
      out.push(w);
      R = W.subtractWord(R, w);
    }
  }
  return out;
}

function validateWords(view: MatchView, words: unknown): string[] {
  if (!Array.isArray(words)) return [];
  let R = W.rackToCounts(view.myRack);
  const out: string[] = [];
  for (const raw of words) {
    if (typeof raw !== "string") continue;
    const w = raw.toUpperCase();
    if (w.length >= 2 && /^[A-Z]+$/.test(w) && W.isWord(w) && W.canSpell(R, w)) {
      out.push(w);
      R = W.subtractWord(R, w);
    }
  }
  return out;
}

function mergeConfig(over?: Partial<FinalConfig>): FinalConfig {
  let env: Partial<FinalConfig> = {};
  try {
    const raw = typeof process !== "undefined" ? process.env["FINAL"] : undefined;
    if (raw) env = JSON.parse(raw) as Partial<FinalConfig>;
  } catch {
    env = {};
  }
  return { ...FINAL_DEFAULTS, ...(over ?? {}), ...env };
}

interface Slot {
  sub: Strategy;
  rule: RuleName;
  players: number;
}

export function createFinal(over?: Partial<FinalConfig>, name = "final"): Strategy {
  const cfg = mergeConfig(over);
  const burnP: BurnParams = { ...BURN_DEFAULTS, ...cfg.burnParams };
  const slots = new Map<number, Slot>(); // matchId -> sub-strategy
  const order: number[] = [];

  function slotFor(view: MatchView, announce: boolean): Slot {
    let s = slots.get(view.matchId);
    if (s) return s;
    const players = view.players.length;
    const rule: RuleName =
      players <= 2 ? (view.auctionType === "FirstPrice" ? cfg.huFP : cfg.hu) : (cfg.byPlayers?.[String(players)] ?? cfg.multi);
    let sub: Strategy;
    try {
      sub = makeRule(rule, cfg);
    } catch {
      sub = FACTORIES.economist();
    }
    s = { sub, rule, players };
    slots.set(view.matchId, s);
    order.push(view.matchId);
    while (order.length > 16) slots.delete(order.shift()!);
    if (announce) {
      try {
        sub.onMatchStart?.(view);
      } catch {
        /* a throwing sub-strategy falls back to defaults below */
      }
    }
    return s;
  }

  return {
    name,

    onMatchStart(view) {
      // A fresh instance for every match, even when the same matchId is announced twice (reconnect).
      slots.delete(view.matchId);
      const i = order.indexOf(view.matchId);
      if (i >= 0) order.splice(i, 1);
      slotFor(view, true);
    },

    words(view) {
      let s: Slot;
      try {
        const fresh = !slots.has(view.matchId);
        s = slotFor(view, fresh);
      } catch {
        return [];
      }
      try {
        if (cfg.dumpAt > 0 && view.bagRemaining > 0 && view.bagRemaining <= cfg.dumpAt) {
          const d = dumpWords(view, cfg.dumpBudgetMs);
          if (d.length > 0) return d;
        }
        return validateWords(view, s.sub.words(view));
      } catch {
        try {
          return view.bagRemaining <= 1 ? dumpWords(view, cfg.dumpBudgetMs) : [];
        } catch {
          return [];
        }
      }
    },

    bid(view, letter) {
      const bal = Math.max(0, Math.floor(Number.isFinite(view.myBalance) ? view.myBalance : 0));
      if (view.bagRemaining === 0 || bal <= 0) return 0;
      try {
        const s = slotFor(view, !slots.has(view.matchId));
        let b = s.sub.bid(view, letter);
        if (cfg.burn && (cfg.burnRules ?? [cfg.multi]).includes(s.rule) && s.players >= 3) b = burnBid(view, letter, b, burnP);
        if (!Number.isFinite(b)) return 0;
        return Math.max(0, Math.min(bal, Math.round(b)));
      } catch {
        return 0;
      }
    },

    onAuctionResult(view: MatchView, rec: AuctionRecord) {
      try {
        const s = slots.get(view.matchId) ?? slotFor(view, true);
        s.sub.onAuctionResult?.(view, rec);
      } catch {
        /* ignore */
      }
    },
  };
}

// ---- JIT / cache warm-up -------------------------------------------------------------------------------------------

const WARM_BAG = "EAIRTONSLDUEAIORTNSLGEAIRTNSOBCMPEAIOUTNRFHVWYKJXQZ";

function synthView(matchId: number, players: number, type: "Vickrey" | "FirstPrice", rackStr: string, round: number, total: number, bal: number): MatchView {
  const rack = new Map<string, number>();
  for (const c of rackStr) rack.set(c, (rack.get(c) ?? 0) + 1);
  const ps = [];
  for (let i = 0; i < players; i++) ps.push({ botId: 100 + i, balance: i === 0 ? bal : 70, score: i === 0 ? 20 : 25, isSim: false });
  const hist: AuctionRecord[] = [];
  for (let r = 1; r < round; r++) {
    hist.push({ round: r, letter: WARM_BAG[(r * 7) % WARM_BAG.length]!, winnerBotId: 100 + (r % players), paid: 6 + (r % 9) });
  }
  return {
    matchId,
    myBotId: 100,
    auctionType: type,
    auctionDurationMs: 1000,
    startingRackSize: 5,
    players: ps,
    myRack: rack,
    myBalance: bal,
    myScore: 20,
    round,
    bagRemaining: Math.max(0, total - round),
    auctionHistory: hist,
    wordHistory: [],
  };
}

/** Run a few synthetic auctions through each rule so JIT-compiled code and caches are hot before match one. */
export function warmUpStrategies(): number {
  const t0 = performance.now();
  try {
    W.warmUp();
    const big = new Map<string, number>();
    for (const c of "AEEIOLNRSTDGUAEILNRSTBC") big.set(c, (big.get(c) ?? 0) + 1);
    W.bestPartition(W.rackToCounts(big), { timeBudgetMs: 30 });
    W.clearPartitionCache();
    let mid = 900000;
    for (const [players, type] of [[6, "Vickrey"], [2, "Vickrey"], [4, "FirstPrice"]] as const) {
      const fin = createFinal({}, "warm");
      const racks = ["AEIRT", "AEIRTNS", "AEIRTNSQ", "AEIRTNSDOL", "AEIRTNSDOLBCU", "AEIRTNSDOLBCUGE", "ERTOLNSAEIDUGBC"];
      const id = mid++;
      fin.onMatchStart?.(synthView(id, players, type, racks[0]!, 1, 68, 100));
      for (let k = 0; k < racks.length; k++) {
        const round = 4 + k * 9;
        const v = synthView(id, players, type, racks[k]!, round, 68, 100 - k * 8);
        fin.words(v);
        fin.bid(v, WARM_BAG[(k * 5) % WARM_BAG.length]!);
        fin.bid(v, "Z");
      }
      const last = synthView(id, players, type, "AEIRTNS", 67, 68, 40);
      fin.words(last);
      fin.words(synthView(id, players, type, "AEIRTNS", 66, 68, 40));
      fin.bid(last, "E");
    }
    W.clearPartitionCache();
  } catch {
    /* warm-up is best-effort */
  }
  return performance.now() - t0;
}

let warmedMs = -1;
export function createStrategy(): Strategy {
  if (warmedMs < 0) warmedMs = warmUpStrategies(); // once per process; later instances reuse the hot code
  return createFinal();
}

// A/B variants for the simulator registry (no warm-up, no env needed).
export const STRATEGIES: Record<string, () => Strategy> = {
  "fin-b0d0": () => createFinal({ burn: false, dumpAt: 0 }, "fin-b0d0"),
  "fin-b0d0x": () => createFinal({ burn: false, dumpAt: 0 }, "fin-b0d0x"), // identical to fin-b0d0: cache-order control
  "fin-b1d0": () => createFinal({ burn: true, dumpAt: 0 }, "fin-b1d0"),
  "fin-b1d1": () => createFinal({ burn: true, dumpAt: 1 }, "fin-b1d1"),
  "fin-b1d2": () => createFinal({ burn: true, dumpAt: 2 }, "fin-b1d2"),
  "fin-b1d3": () => createFinal({ burn: true, dumpAt: 3 }, "fin-b1d3"),
  "fin-hu-tuned": () => createFinal({ hu: "tuned", huFP: "tuned" }, "fin-hu-tuned"),
  "fin-fp-adv": () => createFinal({ huFP: "adversary" }, "fin-fp-adv"), // FP heads-up with the adversary rule (== tuned engine)
  "fin-hu-econ": () => createFinal({ hu: "economist" }, "fin-hu-econ"),
  "fin-hu-mcv": () => createFinal({ hu: "mcvalue" }, "fin-hu-mcv"),
  // adaptive-opponent probes for the heads-up rule (test the default adversary against retuned copies of itself)
  "fin-adv-push11": () => createAdversary({ push: 1.1, pushCapFrac: 0.4, pushMinFrac: 0.2 }),
  "fin-adv-push08": () => createAdversary({ push: 0.8, pushCapFrac: 0.25 }),
  "fin-adv-cap5": () => createAdversary({ pushCapFrac: 0.5, pushMinFrac: 0.2 }),
  "fin-adv-cap7": () => createAdversary({ pushCapFrac: 0.7, pushMinFrac: 0.15 }),
  "fin-adv-cap9": () => createAdversary({ pushCapFrac: 0.9, pushMinFrac: 0.1 }),
  "fin-adv-cap7m1": () => createAdversary({ pushCapFrac: 0.7, pushMinFrac: 0.1 }),
  "fin-adv-cap7p09": () => createAdversary({ pushCapFrac: 0.7, pushMinFrac: 0.15, push: 0.9 }),
  "fin-adv-cap5m3": () => createAdversary({ pushCapFrac: 0.5, pushMinFrac: 0.3 }),
};

export default createStrategy;
