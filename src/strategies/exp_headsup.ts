// exp_headsup: heads-up (2 players) experiments. Does not touch final.ts.
//
//   createStrategy()  == the heads-up behaviour of `final`: advR (adversary, pushCapFrac .7, pushMinFrac .15) for Vickrey,
//                        economist for FirstPrice, early rack dump at 0 < bagRemaining <= 1, exception-safe wrapper.
//   STRATEGIES        named variants (hx-*) with a single change each, plus adaptive-opponent copies (hxo-*).
//
// All variants reuse the SAME wrapper so only the sub-strategy differs.

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { createStrategy as createAdversary, type AdvParams } from "./adversary.js";
import { createEconomist, type EconParams } from "./economist.js";
import { createStrategy as createTuned } from "./tuned.js";
import { createStrategy as createMcvalue } from "./mcvalue.js";

function rackTotal(rack: Map<string, number>): number {
  let t = 0;
  for (const n of rack.values()) t += n;
  return t;
}

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

export const ADV_ROBUST: Partial<AdvParams> = { pushCapFrac: 0.7, pushMinFrac: 0.15 };

export interface HxConfig {
  vick: () => Strategy; // heads-up Vickrey sub-strategy
  fp: () => Strategy; // heads-up FirstPrice sub-strategy
  dumpAt: number;
}

/** Per-match dispatcher: fresh sub-strategy per matchId, early dump, validated words, clamped bids. */
export function makeHx(cfg: HxConfig, name: string): Strategy {
  const slots = new Map<number, Strategy>();
  const order: number[] = [];
  function slotFor(view: MatchView, announce: boolean): Strategy {
    let s = slots.get(view.matchId);
    if (s) return s;
    s = view.auctionType === "FirstPrice" ? cfg.fp() : cfg.vick();
    slots.set(view.matchId, s);
    order.push(view.matchId);
    while (order.length > 16) slots.delete(order.shift()!);
    if (announce) {
      try {
        s.onMatchStart?.(view);
      } catch {
        /* ignore */
      }
    }
    return s;
  }
  return {
    name,
    onMatchStart(view) {
      slots.delete(view.matchId);
      const i = order.indexOf(view.matchId);
      if (i >= 0) order.splice(i, 1);
      slotFor(view, true);
    },
    words(view) {
      try {
        const s = slotFor(view, !slots.has(view.matchId));
        if (cfg.dumpAt > 0 && view.bagRemaining > 0 && view.bagRemaining <= cfg.dumpAt) {
          const d = dumpWords(view, 30);
          if (d.length > 0) return d;
        }
        return validateWords(view, s.words(view));
      } catch {
        try {
          return view.bagRemaining <= 1 ? dumpWords(view, 30) : [];
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
        const b = s.bid(view, letter);
        if (!Number.isFinite(b)) return 0;
        return Math.max(0, Math.min(bal, Math.round(b)));
      } catch {
        return 0;
      }
    },
    onAuctionResult(view: MatchView, rec: AuctionRecord) {
      try {
        const s = slots.get(view.matchId) ?? slotFor(view, true);
        s.onAuctionResult?.(view, rec);
      } catch {
        /* ignore */
      }
    },
  };
}

const econ = (o: Partial<EconParams> = {}) => () => createEconomist(o);
const adv = (o: Partial<AdvParams>) => () => createAdversary(o);
const hx = (name: string, vick: () => Strategy, fp: () => Strategy = econ(), dumpAt = 1) => [name, () => makeHx({ vick, fp, dumpAt }, name)] as const;

export function createStrategy(): Strategy {
  return makeHx({ vick: adv(ADV_ROBUST), fp: econ(), dumpAt: 1 }, "exp_headsup");
}

const entries: (readonly [string, () => Strategy])[] = [
  // ---- Vickrey heads-up variants (control = hx-c7 == final's heads-up rule) ----
  hx("hx-c7", adv(ADV_ROBUST)),
  hx("hx-c9", adv({ pushCapFrac: 0.9, pushMinFrac: 0.1 })),
  hx("hx-c9m15", adv({ pushCapFrac: 0.9, pushMinFrac: 0.15 })),
  hx("hx-c8", adv({ pushCapFrac: 0.8, pushMinFrac: 0.12 })),
  hx("hx-c7p11", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, push: 1.1 })),
  hx("hx-c7p09", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, push: 0.9 })),
  hx("hx-c7t12", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, tmult: 1.2 })),
  hx("hx-c7t08", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, tmult: 0.85 })),
  hx("hx-c7deny", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, deny: 1.25 })),
  hx("hx-c7u3", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, pushUntilBag: 3 })),
  hx("hx-c7u10", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, pushUntilBag: 10 })),
  hx("hx-c7s3", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, startRound: 3 })),
  hx("hx-c7s10", adv({ pushCapFrac: 0.7, pushMinFrac: 0.15, startRound: 10 })),
  hx("hx-tuned", () => createTuned()),
  hx("hx-econ", econ()),
  hx("hx-mcv", () => createMcvalue()),
  // ---- FirstPrice heads-up candidates (all with the same wrapper/dump) ----
  hx("hxfp-econ", adv(ADV_ROBUST), econ()),
  hx("hxfp-tuned", adv(ADV_ROBUST), () => createTuned()),
  hx("hxfp-adv", adv(ADV_ROBUST), adv(ADV_ROBUST)),
  hx("hxfp-econ-fp1", adv(ADV_ROBUST), econ({ fpShade0: 1.0 })),
  hx("hxfp-econ-fp12", adv(ADV_ROBUST), econ({ fpShade0: 1.2 })),
  hx("hxfp-econ-fp09", adv(ADV_ROBUST), econ({ fpShade0: 0.9 })),
  hx("hxfp-econ-k18", adv(ADV_ROBUST), econ({ kappa: 1.8 })),
  hx("hxfp-econ-k12", adv(ADV_ROBUST), econ({ kappa: 1.2 })),
  // ---- adaptive-opponent copies (bare adversary instances, no wrapper) ----
  ["hxo-c3", () => createAdversary()],
  ["hxo-c5", () => createAdversary({ pushCapFrac: 0.5, pushMinFrac: 0.2 })],
  ["hxo-c7", () => createAdversary(ADV_ROBUST)],
  ["hxo-c9", () => createAdversary({ pushCapFrac: 0.9, pushMinFrac: 0.1 })],
  ["hxo-c9p12", () => createAdversary({ pushCapFrac: 0.9, pushMinFrac: 0.1, push: 1.2 })],
  ["hxo-deny", () => createAdversary({ pushCapFrac: 0.7, pushMinFrac: 0.15, deny: 1.4, denyCapFrac: 0.6 })],
  ["hxo-econ-aggr", () => createEconomist({ kappa: 2.2 }, "hxo-econ-aggr")],
];

export const STRATEGIES: Record<string, () => Strategy> = Object.fromEntries(entries);

export default createStrategy;
