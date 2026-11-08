// Dictionary, letter values and best-word search for the simulator.
//
// Faithful to upstream spacetimedb/src/{dictionary,letters}.ts:
//   - isValidWord: ASCII-uppercase the input, >= 2 chars, A-Z only, in the wordlist.
//   - findBestPlayable(rack, minLen): the longest word (>= minLen) that the rack can spell; among words of
//     equal length, the lexicographically first (that is the server's by-length-desc-then-lex scan order).
//
// The server scans all 172k words per call. That is far too slow for a simulator, so `findBestPlayable` here
// walks a trie constrained by the rack (with depth pruning). `findBestPlayableRef` is a literal port of the
// server scan; engine.test.ts checks the two agree on thousands of random racks.

import { readFileSync } from "node:fs";

const WORDLIST_URL = new URL("../../data/wordlist.txt", import.meta.url);
const A = 65;

let LEX: string[] | undefined;
let WORD_SET: Set<string> | undefined;

/** The wordlist in file order (lexicographic), exactly like the server's lexWords(). */
export function lexWords(): string[] {
  LEX ??= readFileSync(WORDLIST_URL, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  return LEX;
}

function wordSet(): Set<string> {
  WORD_SET ??= new Set(lexWords());
  return WORD_SET;
}

// ---------- Letters ----------

const VALUES = new Uint8Array(26);
{
  const groups: [string, number][] = [
    ["AEIOULNSTR", 1],
    ["DG", 2],
    ["BCMP", 3],
    ["FHVWY", 4],
    ["K", 5],
    ["JX", 8],
    ["QZ", 10],
  ];
  for (const [letters, v] of groups) for (const c of letters) VALUES[c.charCodeAt(0) - A] = v;
}

/** Letter value of an uppercase A-Z character (0 for anything else, like the server). */
export function letterValue(c: string): number {
  const i = c.charCodeAt(0) - A;
  return i >= 0 && i < 26 ? VALUES[i]! : 0;
}
export const LETTER_VALUES: Readonly<Uint8Array> = VALUES;

/** Standard Scrabble distribution without blanks, 98 tiles (letters.ts DEFAULT_BAG). */
export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3], ["H", 2], ["I", 9],
  ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6], ["O", 8], ["P", 2], ["Q", 1], ["R", 6],
  ["S", 4], ["T", 6], ["U", 4], ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];
export const BAG_SIZE = 98;

/** The 98 tiles as letter indices 0..25, in A-Z order (the server's `entries` order). */
export function fullBagIndices(): Uint8Array {
  const out = new Uint8Array(BAG_SIZE);
  let k = 0;
  for (const [letter, count] of DEFAULT_BAG) {
    for (let i = 0; i < count; i++) out[k++] = letter.charCodeAt(0) - A;
  }
  return out;
}

/** Length multiplier as [numerator, denominator] (letters.ts lengthMultiplier). */
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

/** reward = floor(sum(letterValue) * num / den). Same integer math as the server (BigInt division). */
export function wordReward(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += letterValue(word[i]!);
  const [num, den] = lengthMultiplier(word.length);
  return Math.floor((base * num) / den);
}

// ---------- Validation ----------

export type WordCheck = { ok: true; word: string } | { ok: false; reason: "format" | "not-in-dictionary" };

/** Mirrors submit_word's checks: uppercase a-z, >= 2 letters, A-Z only, in the dictionary. */
export function checkWord(raw: unknown): WordCheck {
  if (typeof raw !== "string") return { ok: false, reason: "format" };
  const word = raw.replace(/[a-z]/g, (c) => c.toUpperCase());
  if (word.length < 2 || !/^[A-Z]+$/.test(word)) return { ok: false, reason: "format" };
  if (!wordSet().has(word)) return { ok: false, reason: "not-in-dictionary" };
  return { ok: true, word };
}

export function isValidWord(word: string): boolean {
  return checkWord(word).ok;
}

// ---------- Literal port of the server scan (reference) ----------

let BY_LENGTH: string[] | undefined;
function wordsByLength(): string[] {
  BY_LENGTH ??= [...lexWords()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return BY_LENGTH;
}

const U32_MAX = 0xffffffff;

/** Literal port of upstream findBestPlayable. Slow (full scan); used only to verify the trie version. */
export function findBestPlayableRef(rack: Map<string, number>, minLen: number): string | undefined {
  const rackCounts = new Array<number>(26).fill(0);
  let total = 0;
  for (const [c, n] of rack) {
    if (/^[A-Z]$/.test(c)) {
      const slot = c.charCodeAt(0) - A;
      rackCounts[slot] = Math.min(rackCounts[slot]! + n, U32_MAX);
      total = Math.min(total + n, U32_MAX);
    }
  }
  if (total < minLen) return undefined;

  const need = new Array<number>(26);
  for (const word of wordsByLength()) {
    if (word.length < minLen) break;
    if (word.length > total) continue;
    need.fill(0);
    let ok = true;
    for (let i = 0; i < word.length; i++) {
      const slot = word.charCodeAt(i) - A;
      if (slot < 0 || slot >= 26) {
        ok = false;
        break;
      }
      need[slot]!++;
    }
    if (!ok) continue;
    if (need.every((n, i) => n <= rackCounts[i]!)) return word;
  }
  return undefined;
}

// ---------- Trie (first-child / next-sibling, children in alphabetical order) ----------

let firstChild: Int32Array;
let nextSib: Int32Array;
let chOf: Uint8Array;
let isWordNode: Uint8Array;
let maxDepth: Uint8Array; // longest word in the subtree (0 if none)
let trieReady = false;

function buildTrie(): void {
  const words = lexWords();
  let totalChars = 1;
  for (const w of words) totalChars += w.length;
  const fc = new Int32Array(totalChars).fill(-1);
  const ns = new Int32Array(totalChars).fill(-1);
  const lastChild = new Int32Array(totalChars).fill(-1);
  const parent = new Int32Array(totalChars).fill(-1);
  const ch = new Uint8Array(totalChars);
  const iw = new Uint8Array(totalChars);
  const depth = new Uint8Array(totalChars);
  const stack = new Int32Array(64); // stack[d] = node at depth d along the previous word
  stack[0] = 0;
  let n = 1;
  let prev = "";
  for (const w of words) {
    let lcp = 0;
    const lim = Math.min(prev.length, w.length);
    while (lcp < lim && prev.charCodeAt(lcp) === w.charCodeAt(lcp)) lcp++;
    for (let i = lcp; i < w.length; i++) {
      const p = stack[i]!;
      const id = n++;
      ch[id] = w.charCodeAt(i) - A;
      parent[id] = p;
      depth[id] = i + 1;
      if (lastChild[p] === -1) fc[p] = id;
      else ns[lastChild[p]!] = id;
      lastChild[p] = id;
      stack[i + 1] = id;
    }
    iw[stack[w.length]!] = 1;
    prev = w;
  }
  const md = new Uint8Array(n);
  for (let i = 1; i < n; i++) if (iw[i]) md[i] = depth[i]!;
  for (let i = n - 1; i >= 1; i--) {
    const p = parent[i]!;
    if (md[i]! > md[p]!) md[p] = md[i]!;
  }
  firstChild = fc.subarray(0, n);
  nextSib = ns.subarray(0, n);
  chOf = ch.subarray(0, n);
  isWordNode = iw.subarray(0, n);
  maxDepth = md;
  trieReady = true;
}

// Search state (module-level to avoid per-call allocation; the search is synchronous and non-reentrant).
const cnt = new Int32Array(26);
const path = new Int32Array(64);
const bestPath = new Int32Array(64);
let bestLen = 0;
let needMin = 0;

function dfs(node: number, depth: number, remaining: number): void {
  for (let c = firstChild[node]!; c !== -1; c = nextSib[c]!) {
    const letter = chOf[c]!;
    if (cnt[letter] === 0) continue;
    // Can this subtree hold a word that is >= minLen and strictly longer than the best so far?
    const need = bestLen >= needMin ? bestLen + 1 : needMin;
    if (maxDepth[c]! < need) continue;
    if (depth + remaining < need) continue;
    cnt[letter]!--;
    path[depth] = letter;
    if (isWordNode[c] && depth + 1 >= needMin && depth + 1 > bestLen) {
      bestLen = depth + 1;
      for (let i = 0; i <= depth; i++) bestPath[i] = path[i]!;
    }
    dfs(c, depth + 1, remaining - 1);
    cnt[letter]!++;
  }
}

/**
 * Fast equivalent of the server's findBestPlayable, taking letter counts indexed A=0..Z=25.
 * Longest word with length >= minLen that the counts can spell; ties -> lexicographically first.
 */
export function findBestPlayableCounts(counts: ArrayLike<number>, minLen: number): string | undefined {
  if (!trieReady) buildTrie();
  let total = 0;
  for (let i = 0; i < 26; i++) {
    const v = counts[i]!;
    cnt[i] = v;
    total += v;
  }
  if (total < minLen) return undefined;
  bestLen = 0;
  needMin = minLen < 1 ? 1 : minLen;
  dfs(0, 0, total);
  if (bestLen === 0) return undefined;
  let s = "";
  for (let i = 0; i < bestLen; i++) s += String.fromCharCode(A + bestPath[i]!);
  return s;
}

/** Same signature as the server's findBestPlayable(rack, minLen). */
export function findBestPlayable(rack: Map<string, number>, minLen: number): string | undefined {
  const counts = new Array<number>(26).fill(0);
  for (const [c, n] of rack) {
    if (/^[A-Z]$/.test(c)) counts[c.charCodeAt(0) - A]! += n;
  }
  return findBestPlayableCounts(counts, minLen);
}

/** Force trie construction (so timing measurements don't include it). */
export function warmDictionary(): void {
  lexWords();
  wordSet();
  if (!trieReady) buildTrie();
}

export function letterIndex(c: string): number {
  return c.charCodeAt(0) - A;
}
export function indexLetter(i: number): string {
  return String.fromCharCode(A + i);
}
