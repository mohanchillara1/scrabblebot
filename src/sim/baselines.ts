// Reference opponents for the simulator, as ordinary `Strategy` objects.
//
//   starter       the official bot-starter: decideBid (face value + 2 for a letter you hold none of, else face
//                 value, clamped to the balance) and chooseWord (greedy longest word, ties lexicographically first,
//                 min 2 letters), playing one word per auction whenever any word is spellable.
//   starter-hold7 same bidding; plays only words of length >= 7 (as many as the rack allows), and on the last
//                 auction (bagRemaining == 0) dumps everything with the starter's greedy chooser.
//   value-plus    always bids face value + 3 (clamped to the balance); plays the longest word of length >= 5
//                 whenever one exists (repeatedly, until none is left).
//
// Word search uses the simulator's trie (dict.ts), which is verified identical to the starter's linear scan.

import type { MatchView, Strategy } from "../core/types.js";
import { findBestPlayableCounts, letterIndex, LETTER_VALUES } from "./dict.js";

function countsOf(rack: Map<string, number>): Int32Array {
  const c = new Int32Array(26);
  for (const [l, n] of rack) c[letterIndex(l)]! += n;
  return c;
}

function faceValue(letter: string): number {
  return LETTER_VALUES[letterIndex(letter)] ?? 1;
}

/** bot-starter strategy.ts decideBid(), ported verbatim (LETTER_VALUE table == letters.ts values). */
export function starterBid(view: MatchView, letter: string): number {
  const value = faceValue(letter);
  const have = view.myRack.get(letter) ?? 0;
  const want = have === 0 ? value + 2 : Math.max(1, value);
  return Math.min(want, Math.max(0, view.myBalance));
}

/** bot-starter strategy.ts chooseWord() result for a rack (greedy longest, min 2 letters). */
export function starterWord(rack: Map<string, number>): string | null {
  return findBestPlayableCounts(countsOf(rack), 2) ?? null;
}

export function createStarter(): Strategy {
  return {
    name: "starter",
    words(view) {
      const w = starterWord(view.myRack);
      return w ? [w] : [];
    },
    bid: starterBid,
  };
}

/** Repeatedly take the best word of length >= minLen from the rack. */
function drain(rack: Map<string, number>, minLen: number): string[] {
  const counts = countsOf(rack);
  const out: string[] = [];
  for (;;) {
    const w = findBestPlayableCounts(counts, minLen);
    if (w === undefined) return out;
    out.push(w);
    for (let i = 0; i < w.length; i++) counts[w.charCodeAt(i) - 65]!--;
  }
}

export function createStarterHold7(): Strategy {
  return {
    name: "starter-hold7",
    words(view) {
      return drain(view.myRack, view.bagRemaining === 0 ? 2 : 7);
    },
    bid: starterBid,
  };
}

export function createValuePlus(): Strategy {
  return {
    name: "value-plus",
    words(view) {
      return drain(view.myRack, 5);
    },
    bid(view, letter) {
      return Math.min(faceValue(letter) + 3, Math.max(0, view.myBalance));
    },
  };
}

export const BASELINES: Record<string, () => Strategy> = {
  starter: createStarter,
  "starter-hold7": createStarterHold7,
  "value-plus": createValuePlus,
};
