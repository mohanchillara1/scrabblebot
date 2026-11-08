// Fast word engine for the ScrabbleBot strategies.
//
// Data model
//   * The dictionary (data/wordlist.txt) is loaded once, lazily, from a path relative to this
//     module (import.meta.url), never from cwd.
//   * Words are grouped into SIGNATURES (anagram classes = sorted-letter multisets). All anagrams
//     share a reward, so most work happens at signature level. Signature ids are assigned in
//     lexicographic order of the sorted-letter string.
//   * A "multiset trie" (trie over the sorted letters of each signature, CSR layout, BFS node ids)
//     lets playableWords / bestWord walk only sub-multisets of the rack that are dictionary
//     prefixes. Subtree max-reward / max-length annotations allow branch-and-bound.
//   * Near-word helpers (completion tables, "how many letters from a 7+ word") are linear scans
//     over signatures with a 26-bit letter-mask popcount prefilter.
//
// Reward rule (letters.ts): reward = floor(base * num / den), base = sum of letter values,
// multiplier by length: <=3 -> 1, 4 -> 3/2, 5 -> 2, 6 -> 5/2, 7+ -> 3.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Counts = Uint8Array; // length 26, index 0 = 'A'

export const NUM_LETTERS = 26;
const CODE_A = 65;

export const LETTER_VALUES: Readonly<Uint8Array> = Uint8Array.from([
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]);

/** Standard 98-tile bag, no blanks (letters.ts DEFAULT_BAG). Index 0 = 'A'. */
export const BAG_COUNTS: Readonly<Uint8Array> = Uint8Array.from([
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
]);

// ---------------------------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------------------------

/** Letter value of an uppercase A-Z letter; 0 for anything else (mirrors letters.ts). */
export function letterValue(c: string): number {
  const i = c.charCodeAt(0) - CODE_A;
  return i >= 0 && i < 26 ? LETTER_VALUES[i]! : 0;
}

/** floor(base * num / den) for the length multiplier, exactly as the server computes it. */
export function rewardFromBase(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

/** Reward credited for playing `word` (uppercase A-Z; does not check the dictionary). */
export function reward(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) {
    const k = word.charCodeAt(i) - CODE_A;
    if (k >= 0 && k < 26) base += LETTER_VALUES[k]!;
  }
  return rewardFromBase(base, word.length);
}

export function newCounts(): Counts {
  return new Uint8Array(26);
}

/** Map<letter, count> (uppercase letters; others ignored) -> Counts. */
export function rackToCounts(rack: Map<string, number>): Counts {
  const c = new Uint8Array(26);
  for (const [letter, n] of rack) {
    const k = letter.charCodeAt(0) - CODE_A;
    if (k >= 0 && k < 26 && n > 0) c[k] = Math.min(255, c[k]! + n);
  }
  return c;
}

/** Counts -> Map<letter, count> containing only letters with count > 0. */
export function countsToMap(c: Counts): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < 26; i++) if (c[i]! > 0) m.set(String.fromCharCode(CODE_A + i), c[i]!);
  return m;
}

/** Uppercase word (or any string of letters) -> Counts. Non A-Z characters are ignored. */
export function wordToCounts(word: string): Counts {
  const c = new Uint8Array(26);
  for (let i = 0; i < word.length; i++) {
    const k = word.charCodeAt(i) - CODE_A;
    if (k >= 0 && k < 26) c[k]!++;
  }
  return c;
}

/** Counts -> sorted-letter string, e.g. "AEINRST". */
export function countsToString(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) if (c[i]! > 0) s += String.fromCharCode(CODE_A + i).repeat(c[i]!);
  return s;
}

export function totalTiles(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]!;
  return t;
}

/** Sum of letter values of the tiles in `c`. */
export function tileValue(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]! * LETTER_VALUES[i]!;
  return t;
}

/** True if every letter of `word` is available in `rack` (multiplicities respected). */
export function canSpell(rack: Counts, word: string): boolean {
  const need = wordToCounts(word);
  for (let i = 0; i < 26; i++) if (need[i]! > rack[i]!) return false;
  return true;
}

/** rack - word (clamped at 0). */
export function subtractWord(rack: Counts, word: string): Counts {
  const out = rack.slice();
  for (let i = 0; i < word.length; i++) {
    const k = word.charCodeAt(i) - CODE_A;
    if (k >= 0 && k < 26 && out[k]! > 0) out[k]!--;
  }
  return out;
}

/** Exact 13-char string key for a count vector (counts <= 255). */
export function countsKey(c: Counts): string {
  return String.fromCharCode(
    (c[0]! << 8) | c[1]!, (c[2]! << 8) | c[3]!, (c[4]! << 8) | c[5]!, (c[6]! << 8) | c[7]!,
    (c[8]! << 8) | c[9]!, (c[10]! << 8) | c[11]!, (c[12]! << 8) | c[13]!, (c[14]! << 8) | c[15]!,
    (c[16]! << 8) | c[17]!, (c[18]! << 8) | c[19]!, (c[20]! << 8) | c[21]!, (c[22]! << 8) | c[23]!,
    (c[24]! << 8) | c[25]!,
  );
}

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function rackMaskOf(rack: Counts): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (rack[i]! > 0) m |= 1 << i;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Dictionary (lazy singleton)
// ---------------------------------------------------------------------------------------------

export interface Dict {
  nWords: number;
  nSig: number;
  maxLen: number;
  /** Words grouped by signature; inside a group lexicographic. */
  words: string[];
  sigWordStart: Int32Array; // nSig+1
  sigLen: Uint8Array;
  sigReward: Int32Array;
  sigMask: Int32Array; // 26-bit letter-presence mask
  sigCnt: Uint8Array; // nSig*26 letter counts
  sigPairStart: Int32Array; // nSig+1, into pairLetter/pairCount (distinct letters ascending)
  pairLetter: Uint8Array;
  pairCount: Uint8Array;
  /** sig ids with length L are sigByLen[lenStart[L] .. lenStart[L+1]) */
  lenStart: Int32Array;
  sigByLen: Int32Array;
  // multiset trie
  nNodes: number;
  firstChild: Int32Array;
  nChild: Uint8Array;
  nodeLetter: Uint8Array;
  nodeSig: Int32Array; // signature ending at this node, or -1
  subMaxReward: Int32Array;
  subMaxLen: Uint8Array;
  loadMs: number;
}

let DICT: Dict | undefined;
let WORD_SET: Set<string> | undefined;

export function dictionaryPath(): string {
  return fileURLToPath(new URL("../../data/wordlist.txt", import.meta.url));
}

export function getDict(): Dict {
  if (!DICT) DICT = buildDict();
  return DICT;
}

/** Force-load the dictionary now; returns load time in ms (0 if already loaded). */
export function warmUp(): number {
  if (DICT) return 0;
  return getDict().loadMs;
}

function buildDict(): Dict {
  const t0 = performance.now();
  const text = readFileSync(dictionaryPath(), "latin1");
  const lines = text.split("\n");

  const groups = new Map<string, string[]>();
  const cnt = new Uint8Array(26);
  const scratch = Buffer.alloc(64);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]!;
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    const n = line.length;
    if (n < 2 || n > 60) continue;
    cnt.fill(0);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const k = line.charCodeAt(i) - CODE_A;
      if (k < 0 || k > 25) {
        ok = false;
        break;
      }
      cnt[k]!++;
    }
    if (!ok) continue;
    let p = 0;
    for (let k = 0; k < 26; k++) for (let q = cnt[k]!; q > 0; q--) scratch[p++] = CODE_A + k;
    const sig = scratch.toString("latin1", 0, p);
    const g = groups.get(sig);
    if (g) g.push(line);
    else groups.set(sig, [line]);
  }

  const keys = Array.from(groups.keys()).sort();
  const nSig = keys.length;

  const words: string[] = [];
  const sigWordStart = new Int32Array(nSig + 1);
  const sigLen = new Uint8Array(nSig);
  const sigReward = new Int32Array(nSig);
  const sigMask = new Int32Array(nSig);
  const sigCnt = new Uint8Array(nSig * 26);
  const sigPairStart = new Int32Array(nSig + 1);
  const sigLetOff = new Int32Array(nSig + 1);
  let totalChars = 0;
  let totalPairs = 0;
  for (let s = 0; s < nSig; s++) {
    totalChars += keys[s]!.length;
  }
  const sigLetters = new Uint8Array(totalChars);
  const pairLetterTmp = new Uint8Array(totalChars);
  const pairCountTmp = new Uint8Array(totalChars);
  let maxLen = 0;
  let charPos = 0;
  for (let s = 0; s < nSig; s++) {
    const key = keys[s]!;
    const g = groups.get(key)!;
    if (g.length > 1) g.sort();
    let prev = "";
    sigWordStart[s] = words.length;
    for (const w of g) {
      if (w === prev) continue; // duplicate line in file
      words.push(w);
      prev = w;
    }
    const len = key.length;
    sigLen[s] = len;
    if (len > maxLen) maxLen = len;
    sigLetOff[s] = charPos;
    sigPairStart[s] = totalPairs;
    let base = 0;
    let mask = 0;
    const o = s * 26;
    for (let i = 0; i < len; i++) {
      const k = key.charCodeAt(i) - CODE_A;
      sigLetters[charPos++] = k;
      sigCnt[o + k]!++;
      base += LETTER_VALUES[k]!;
      mask |= 1 << k;
    }
    for (let k = 0; k < 26; k++) {
      if (sigCnt[o + k]! > 0) {
        pairLetterTmp[totalPairs] = k;
        pairCountTmp[totalPairs] = sigCnt[o + k]!;
        totalPairs++;
      }
    }
    sigReward[s] = rewardFromBase(base, len);
    sigMask[s] = mask;
  }
  sigWordStart[nSig] = words.length;
  sigLetOff[nSig] = charPos;
  sigPairStart[nSig] = totalPairs;
  const pairLetter = pairLetterTmp.slice(0, totalPairs);
  const pairCount = pairCountTmp.slice(0, totalPairs);

  // signatures by length (counting sort)
  const lenStart = new Int32Array(maxLen + 2);
  for (let s = 0; s < nSig; s++) lenStart[sigLen[s]! + 1]!++;
  for (let L = 0; L <= maxLen; L++) lenStart[L + 1]! += lenStart[L]!;
  const fill = lenStart.slice();
  const sigByLen = new Int32Array(nSig);
  for (let s = 0; s < nSig; s++) sigByLen[fill[sigLen[s]!]!++] = s;

  // multiset trie, BFS with contiguous children
  const maxNodes = totalChars + 1;
  const nodeLo = new Int32Array(maxNodes);
  const nodeHi = new Int32Array(maxNodes);
  const firstChildT = new Int32Array(maxNodes);
  const nChildT = new Uint8Array(maxNodes);
  const nodeLetterT = new Uint8Array(maxNodes);
  const nodeSigT = new Int32Array(maxNodes).fill(-1);
  nodeLo[0] = 0;
  nodeHi[0] = nSig;
  let nNodes = 1;
  let levelStart = 0;
  let levelEnd = 1;
  let depth = 0;
  while (levelStart < levelEnd) {
    for (let n = levelStart; n < levelEnd; n++) {
      let lo = nodeLo[n]!;
      const hi = nodeHi[n]!;
      if (lo < hi && sigLen[lo] === depth) {
        nodeSigT[n] = lo;
        lo++;
      }
      firstChildT[n] = nNodes;
      let c = 0;
      let i = lo;
      while (i < hi) {
        const ch = sigLetters[sigLetOff[i]! + depth]!;
        let j = i + 1;
        while (j < hi && sigLetters[sigLetOff[j]! + depth] === ch) j++;
        nodeLo[nNodes] = i;
        nodeHi[nNodes] = j;
        nodeLetterT[nNodes] = ch;
        nNodes++;
        c++;
        i = j;
      }
      nChildT[n] = c;
    }
    levelStart = levelEnd;
    levelEnd = nNodes;
    depth++;
  }
  const firstChild = firstChildT.slice(0, nNodes);
  const nChild = nChildT.slice(0, nNodes);
  const nodeLetter = nodeLetterT.slice(0, nNodes);
  const nodeSig = nodeSigT.slice(0, nNodes);
  const subMaxReward = new Int32Array(nNodes);
  const subMaxLen = new Uint8Array(nNodes);
  for (let n = nNodes - 1; n >= 0; n--) {
    let mr = 0;
    let ml = 0;
    const s = nodeSig[n]!;
    if (s >= 0) {
      mr = sigReward[s]!;
      ml = sigLen[s]!;
    }
    const fc = firstChild[n]!;
    const end = fc + nChild[n]!;
    for (let c = fc; c < end; c++) {
      if (subMaxReward[c]! > mr) mr = subMaxReward[c]!;
      if (subMaxLen[c]! > ml) ml = subMaxLen[c]!;
    }
    subMaxReward[n] = mr;
    subMaxLen[n] = ml;
  }

  return {
    nWords: words.length,
    nSig,
    maxLen,
    words,
    sigWordStart,
    sigLen,
    sigReward,
    sigMask,
    sigCnt,
    sigPairStart,
    pairLetter,
    pairCount,
    lenStart,
    sigByLen,
    nNodes,
    firstChild,
    nChild,
    nodeLetter,
    nodeSig,
    subMaxReward,
    subMaxLen,
    loadMs: performance.now() - t0,
  };
}

/** True if `word` (any case) is a valid playable word: >= 2 letters, A-Z only, in the wordlist. */
export function isWord(word: string): boolean {
  if (word.length < 2) return false;
  const up = word.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const k = up.charCodeAt(i);
    if (k < 65 || k > 90) return false;
  }
  if (!WORD_SET) WORD_SET = new Set(getDict().words);
  return WORD_SET.has(up);
}

export function wordCount(): number {
  return getDict().nWords;
}

/** All dictionary words (grouped by anagram class). Do not mutate. */
export function allWords(): readonly string[] {
  return getDict().words;
}

// ---------------------------------------------------------------------------------------------
// playableWords / bestWord
// ---------------------------------------------------------------------------------------------

export interface PlayableOpts {
  minLen?: number; // default 2
  maxLen?: number; // default unlimited
}

const scratchCnt = new Uint8Array(26);

/** Signature ids of every dictionary signature spellable from `rack` with length in [minLen, maxLen]. */
export function playableSigs(rack: Counts, minLen = 2, maxLen = 99): number[] {
  const D = getDict();
  const out: number[] = [];
  const cnt = scratchCnt;
  cnt.set(rack);
  let remaining = totalTiles(rack);
  if (remaining < minLen) return out;
  const { firstChild, nChild, nodeLetter, nodeSig, subMaxLen } = D;
  function rec(node: number, depth: number): void {
    const s = nodeSig[node]!;
    if (s >= 0 && depth >= minLen) out.push(s);
    if (depth >= maxLen) return;
    if (depth + remaining < minLen) return;
    const fc = firstChild[node]!;
    const end = fc + nChild[node]!;
    for (let c = fc; c < end; c++) {
      const L = nodeLetter[c]!;
      if (cnt[L]! > 0 && subMaxLen[c]! >= minLen) {
        cnt[L]!--;
        remaining--;
        rec(c, depth + 1);
        remaining++;
        cnt[L]!++;
      }
    }
  }
  rec(0, 0);
  return out;
}

/** Every dictionary word spellable from the rack (exact). Order: signature (sorted-letter) order. */
export function playableWords(rack: Counts, opts: PlayableOpts = {}): string[] {
  const D = getDict();
  const sigs = playableSigs(rack, opts.minLen ?? 2, opts.maxLen ?? 99);
  const out: string[] = [];
  const { words, sigWordStart } = D;
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    for (let w = sigWordStart[s]!, e = sigWordStart[s + 1]!; w < e; w++) out.push(words[w]!);
  }
  return out;
}

/** Number of playable words (anagram variants counted separately). */
export function countPlayable(rack: Counts, opts: PlayableOpts = {}): number {
  const D = getDict();
  const sigs = playableSigs(rack, opts.minLen ?? 2, opts.maxLen ?? 99);
  let n = 0;
  for (let i = 0; i < sigs.length; i++) n += D.sigWordStart[sigs[i]! + 1]! - D.sigWordStart[sigs[i]!]!;
  return n;
}

/** Histogram: result[L] = number of playable words of length L (index 0..maxLen). */
export function playableByLength(rack: Counts): Int32Array {
  const D = getDict();
  const out = new Int32Array(D.maxLen + 1);
  const sigs = playableSigs(rack, 2, 99);
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    out[D.sigLen[s]!]! += D.sigWordStart[s + 1]! - D.sigWordStart[s]!;
  }
  return out;
}

export interface BestWord {
  word: string;
  reward: number;
}

/**
 * Max-reward single word. Ties: fewer tiles first, then lexicographically smallest.
 * Returns null if nothing of length >= minLen (default 2) is spellable.
 */
export function bestWord(rack: Counts, opts: { minLen?: number } = {}): BestWord | null {
  const D = getDict();
  const minLen = opts.minLen ?? 2;
  const cnt = scratchCnt;
  cnt.set(rack);
  let remaining = totalTiles(rack);
  if (remaining < minLen) return null;
  const { firstChild, nChild, nodeLetter, nodeSig, subMaxLen, subMaxReward, sigReward, sigLen, words, sigWordStart } = D;
  let bestReward = -1;
  let bestLen = 0;
  let bestSig = -1;
  function rec(node: number, depth: number): void {
    const s = nodeSig[node]!;
    if (s >= 0 && depth >= minLen) {
      const r = sigReward[s]!;
      if (
        r > bestReward ||
        (r === bestReward &&
          (depth < bestLen ||
            (depth === bestLen && words[sigWordStart[s]!]! < words[sigWordStart[bestSig]!]!)))
      ) {
        bestReward = r;
        bestLen = depth;
        bestSig = s;
      }
    }
    if (depth + remaining < minLen) return;
    const fc = firstChild[node]!;
    const end = fc + nChild[node]!;
    for (let c = fc; c < end; c++) {
      const L = nodeLetter[c]!;
      if (cnt[L]! > 0 && subMaxLen[c]! >= minLen && subMaxReward[c]! >= bestReward) {
        cnt[L]!--;
        remaining--;
        rec(c, depth + 1);
        remaining++;
        cnt[L]!++;
      }
    }
  }
  rec(0, 0);
  if (bestSig < 0) return null;
  void sigLen;
  return { word: words[sigWordStart[bestSig]!]!, reward: bestReward };
}

// ---------------------------------------------------------------------------------------------
// bestPartition: max-total-reward set of disjoint words from a rack
// ---------------------------------------------------------------------------------------------

export interface PartitionOpts {
  /** Wall-clock budget for the exact search (default 30 ms). Greedy incumbent is always returned. */
  timeBudgetMs?: number;
  /** Hard cap on search nodes (default 4,000,000). */
  maxNodes?: number;
  /** Use / fill the cross-call result cache (default true). Only optimal results are cached. */
  useCache?: boolean;
}

export interface PartitionResult {
  words: string[]; // disjoint words, descending reward
  total: number; // sum of rewards
  optimal: boolean; // true = proven optimum, false = best found when the budget ran out
  nodes?: number;
  /** Proven upper bound on the optimum (== total when optimal). */
  upperBound?: number;
}

const PART_CACHE = new Map<string, PartitionResult>();
const PART_CACHE_MAX = 60000;

const ABORT = Symbol("partition-abort");

class PartitionSolver {
  // candidate data (index j in descending-reward order)
  m = 0;
  cSig!: Int32Array;
  cRew!: Int32Array;
  cKey!: Float64Array;
  D1!: Float64Array;
  D2!: Float64Array;
  /** Dual slack D1[j] - reward[j] (>= 0) and its quantised lower bound (monotone in bucket order). */
  slackLow!: Float64Array;
  cMask!: Int32Array;
  y1 = new Float64Array(26);
  y2 = new Float64Array(26);
  bStart = new Int32Array(28);
  bList!: Int32Array;
  // letters / ranking
  R = new Uint8Array(26);
  rl = new Uint8Array(26); // rank -> letter
  nRank = 0;
  stride = new Float64Array(26);
  key = 0;
  memoOn = true;
  // dictionary refs
  dict: Dict;
  // path & incumbent
  stack = new Int32Array(80);
  sp = 0;
  pathReward = 0;
  bestStack = new Int32Array(80);
  bestSp = 0;
  bestTotal = 0;
  // memo
  mCap = 0;
  mMask = 0;
  mKey!: Float64Array;
  mVal!: Int32Array;
  mChoice!: Int32Array;
  mFlag!: Uint8Array; // 0 empty, 1 bound, 2 exact
  mCount = 0;
  // budget
  nodes = 0;
  deadline = 0;
  maxNodes = 0;
  maxMemo = 700000;

  constructor(dict: Dict) {
    this.dict = dict;
  }

  private hash(key: number): number {
    const lo = key >>> 0;
    const hi = (key / 4294967296) >>> 0;
    let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 13;
    return h;
  }

  memoInit(): void {
    this.mCap = 1024;
    this.mMask = this.mCap - 1;
    this.mKey = new Float64Array(this.mCap);
    this.mVal = new Int32Array(this.mCap);
    this.mChoice = new Int32Array(this.mCap);
    this.mFlag = new Uint8Array(this.mCap);
    this.mCount = 0;
  }

  private memoGrow(): void {
    const oKey = this.mKey, oVal = this.mVal, oCh = this.mChoice, oFlag = this.mFlag, oCap = this.mCap;
    this.mCap = oCap * 2;
    this.mMask = this.mCap - 1;
    this.mKey = new Float64Array(this.mCap);
    this.mVal = new Int32Array(this.mCap);
    this.mChoice = new Int32Array(this.mCap);
    this.mFlag = new Uint8Array(this.mCap);
    for (let i = 0; i < oCap; i++) {
      if (oFlag[i] === 0) continue;
      let s = this.hash(oKey[i]!) & this.mMask;
      while (this.mFlag[s] !== 0) s = (s + 1) & this.mMask;
      this.mKey[s] = oKey[i]!;
      this.mVal[s] = oVal[i]!;
      this.mChoice[s] = oCh[i]!;
      this.mFlag[s] = oFlag[i]!;
    }
  }

  private find(key: number): number {
    let s = this.hash(key) & this.mMask;
    while (this.mFlag[s] !== 0) {
      if (this.mKey[s] === key) return s;
      s = (s + 1) & this.mMask;
    }
    return -1;
  }

  private store(key: number, exact: boolean, val: number, choice: number): void {
    let s = this.hash(key) & this.mMask;
    while (this.mFlag[s] !== 0) {
      if (this.mKey[s] === key) {
        if (this.mFlag[s] === 2) return; // already exact
        if (!exact && this.mVal[s]! <= val) return; // keep tighter bound
        this.mVal[s] = val;
        this.mChoice[s] = choice;
        this.mFlag[s] = exact ? 2 : 1;
        return;
      }
      s = (s + 1) & this.mMask;
    }
    this.mKey[s] = key;
    this.mVal[s] = val;
    this.mChoice[s] = choice;
    this.mFlag[s] = exact ? 2 : 1;
    this.mCount++;
    if (this.mCount * 2 > this.mCap) this.memoGrow();
  }

  /** Build candidate structures for `rack`. Returns false if nothing can be played. */
  setup(rack: Counts, sigsIn: number[]): boolean {
    const D = this.dict;
    const { sigReward, sigLen, sigPairStart, pairLetter, pairCount } = D;
    // counting sort by reward descending (stable in DFS order)
    let maxR = 0;
    for (let i = 0; i < sigsIn.length; i++) if (sigReward[sigsIn[i]!]! > maxR) maxR = sigReward[sigsIn[i]!]!;
    const cntR = new Int32Array(maxR + 2);
    for (let i = 0; i < sigsIn.length; i++) cntR[maxR - sigReward[sigsIn[i]!]! + 1]!++;
    for (let r = 0; r <= maxR; r++) cntR[r + 1]! += cntR[r]!;
    const m = sigsIn.length;
    const cSig = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      const s = sigsIn[i]!;
      cSig[cntR[maxR - sigReward[s]!]!++] = s;
    }
    this.m = m;
    this.cSig = cSig;
    const cRew = new Int32Array(m);
    for (let j = 0; j < m; j++) cRew[j] = sigReward[cSig[j]!]!;
    this.cRew = cRew;

    // which letters appear in any candidate; candidate counts per letter
    const letterCands = new Int32Array(26);
    for (let j = 0; j < m; j++) {
      const s = cSig[j]!;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) letterCands[pairLetter[p]!]!++;
    }
    const R = this.R;
    for (let c = 0; c < 26; c++) R[c] = letterCands[c]! > 0 ? Math.min(rack[c]!, 31) : 0;
    // rank: rarest letter (fewest candidates) first
    const letters: number[] = [];
    for (let c = 0; c < 26; c++) if (R[c]! > 0) letters.push(c);
    letters.sort((a, b) => letterCands[a]! - letterCands[b]! || LETTER_VALUES[b]! - LETTER_VALUES[a]! || a - b);
    this.nRank = letters.length;
    const rk = new Int32Array(26).fill(99);
    for (let i = 0; i < letters.length; i++) {
      this.rl[i] = letters[i]!;
      rk[letters[i]!] = i;
    }
    // strides for mixed-radix exact key
    let P = 1;
    for (let i = 0; i < letters.length; i++) {
      this.stride[letters[i]!] = P;
      P *= R[letters[i]!]! + 1;
    }
    this.memoOn = P < 4503599627370496; // 2^52
    let key = 0;
    for (const c of letters) key += R[c]! * this.stride[c]!;
    this.key = key;

    // buckets by first-ranked letter
    const bCnt = new Int32Array(28);
    const first = new Int8Array(m);
    for (let j = 0; j < m; j++) {
      const s = cSig[j]!;
      let best = 99;
      let bl = 0;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
        const l = pairLetter[p]!;
        if (rk[l]! < best) {
          best = rk[l]!;
          bl = l;
        }
      }
      first[j] = bl;
      bCnt[bl + 1]!++;
    }
    for (let c = 0; c < 26; c++) bCnt[c + 1]! += bCnt[c]!;
    this.bStart = bCnt.slice();
    const bFill = bCnt.slice();
    const bList = new Int32Array(m);
    for (let j = 0; j < m; j++) bList[bFill[first[j]!]!++] = j;
    this.bList = bList;

    // key deltas
    const cKey = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const s = cSig[j]!;
      let kd = 0;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) kd += pairCount[p]! * this.stride[pairLetter[p]!]!;
      cKey[j] = kd;
    }
    this.cKey = cKey;

    // dual bounds
    const s1 = new Float64Array(26);
    const t1 = new Float64Array(26);
    for (let j = 0; j < m; j++) {
      const s = cSig[j]!;
      const len = sigLen[s]!;
      let base = 0;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) base += pairCount[p]! * LETTER_VALUES[pairLetter[p]!]!;
      const share = cRew[j]! / len;
      const eff = cRew[j]! / base;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
        const l = pairLetter[p]!;
        if (share > s1[l]!) s1[l] = share;
        const tv = LETTER_VALUES[l]! * eff;
        if (tv > t1[l]!) t1[l] = tv;
      }
    }
    // per-letter candidate lists for the coordinate descent
    const lStart = new Int32Array(27);
    for (let c = 0; c < 26; c++) lStart[c + 1] = lStart[c]! + letterCands[c]!;
    const lFill = lStart.slice();
    const lList = new Int32Array(lStart[26]!);
    const lCnt = new Uint8Array(lStart[26]!);
    for (let j = 0; j < m; j++) {
      const s = cSig[j]!;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
        const l = pairLetter[p]!;
        const at = lFill[l]!++;
        lList[at] = j;
        lCnt[at] = pairCount[p]!;
      }
    }
    const descend = (y: Float64Array): Float64Array => {
      const Z = new Float64Array(m);
      for (let j = 0; j < m; j++) {
        const s = cSig[j]!;
        let z = 0;
        for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) z += pairCount[p]! * y[pairLetter[p]!]!;
        Z[j] = z;
      }
      for (let sweep = 0; sweep < 6; sweep++) {
        let changed = 0;
        for (let i = 0; i < letters.length; i++) {
          const c = letters[i]!;
          const yc = y[c]!;
          let ny = 0;
          for (let at = lStart[c]!, e = lStart[c + 1]!; at < e; at++) {
            const j = lList[at]!;
            const k = lCnt[at]!;
            const need = (cRew[j]! - (Z[j]! - yc * k)) / k;
            if (need > ny) ny = need;
          }
          if (ny > yc) ny = yc;
          const dy = ny - yc;
          if (dy < -1e-9) {
            changed++;
            for (let at = lStart[c]!, e = lStart[c + 1]!; at < e; at++) Z[lList[at]!]! += dy * lCnt[at]!;
            y[c] = ny;
          }
        }
        if (changed === 0) break;
      }
      return Z;
    };
    this.y1.set(s1);
    this.y2.set(t1);
    let Da = descend(this.y1);
    let Db = descend(this.y2);
    // primary dual = the one with the smaller root bound
    let ra = 0;
    let rb = 0;
    for (let c = 0; c < 26; c++) {
      ra += R[c]! * this.y1[c]!;
      rb += R[c]! * this.y2[c]!;
    }
    if (rb < ra) {
      const ty = this.y1.slice();
      this.y1.set(this.y2);
      this.y2.set(ty);
      const tD = Da;
      Da = Db;
      Db = tD;
    }
    this.D1 = Da;
    this.D2 = Db;
    // Sort every bucket by dual slack ascending (== child upper bound descending at ANY state), ties by reward.
    const slackLow = new Float64Array(m);
    const keys = new Float64Array(m);
    const QS = 256;
    for (let j = 0; j < m; j++) {
      let sl = Da[j]! - cRew[j]!;
      if (sl < 0) sl = 0;
      const q = Math.floor(sl * QS);
      slackLow[j] = q / QS;
      keys[j] = q * 262144 + j; // j < 2^18
    }
    this.slackLow = slackLow;
    const cMask = new Int32Array(m);
    for (let j = 0; j < m; j++) cMask[j] = D.sigMask[cSig[j]!]!;
    this.cMask = cMask;
    for (let c = 0; c < 26; c++) {
      const a = this.bStart[c]!;
      const b = this.bStart[c + 1]!;
      if (b - a < 2) continue;
      const sub = new Float64Array(b - a);
      for (let t = a; t < b; t++) sub[t - a] = keys[bList[t]!]!;
      sub.sort();
      for (let t = a; t < b; t++) bList[t] = sub[t - a]! % 262144;
    }
    return this.nRank > 0;
  }

  bound(S1: number, S2: number): number {
    return Math.floor((S1 < S2 ? S1 : S2) + 1e-6);
  }

  rootSums(): [number, number] {
    let S1 = 0;
    let S2 = 0;
    for (let c = 0; c < 26; c++) {
      S1 += this.R[c]! * this.y1[c]!;
      S2 += this.R[c]! * this.y2[c]!;
    }
    return [S1, S2];
  }

  private applyCand(j: number, sign: number): void {
    const D = this.dict;
    const s = this.cSig[j]!;
    const R = this.R;
    if (sign < 0) for (let p = D.sigPairStart[s]!, e = D.sigPairStart[s + 1]!; p < e; p++) R[D.pairLetter[p]!]! -= D.pairCount[p]!;
    else for (let p = D.sigPairStart[s]!, e = D.sigPairStart[s + 1]!; p < e; p++) R[D.pairLetter[p]!]! += D.pairCount[p]!;
  }

  private fits(j: number): boolean {
    const D = this.dict;
    const s = this.cSig[j]!;
    const R = this.R;
    for (let p = D.sigPairStart[s]!, e = D.sigPairStart[s + 1]!; p < e; p++) if (R[D.pairLetter[p]!]! < D.pairCount[p]!) return false;
    return true;
  }

  private record(): void {
    this.bestTotal = this.pathReward;
    this.bestSp = this.sp;
    for (let i = 0; i < this.sp; i++) this.bestStack[i] = this.stack[i]!;
  }

  /** Current state is exact in the memo; extend the current path with its memoised optimal tail. */
  private recordWithTail(): void {
    const D = this.dict;
    const Rc = this.R.slice();
    let key = this.key;
    const tail: number[] = [];
    let r = 0;
    for (;;) {
      while (r < this.nRank && Rc[this.rl[r]!] === 0) r++;
      if (r === this.nRank) break;
      const slot = this.find(key);
      if (slot < 0 || this.mFlag[slot] !== 2) return; // cannot reconstruct; ignore
      const ch = this.mChoice[slot]!;
      const L = this.rl[r]!;
      if (ch === -1) {
        key -= Rc[L]! * this.stride[L]!;
        Rc[L] = 0;
        r++;
      } else {
        const s = this.cSig[ch]!;
        for (let p = D.sigPairStart[s]!, e = D.sigPairStart[s + 1]!; p < e; p++) Rc[D.pairLetter[p]!]! -= D.pairCount[p]!;
        key -= this.cKey[ch]!;
        tail.push(ch);
      }
      if (tail.length + this.sp > 70) return;
    }
    let total = this.pathReward;
    for (const ch of tail) total += this.cRew[ch]!;
    if (total <= this.bestTotal) return;
    for (let i = 0; i < this.sp; i++) this.bestStack[i] = this.stack[i]!;
    for (let i = 0; i < tail.length; i++) this.bestStack[this.sp + i] = tail[i]!;
    this.bestSp = this.sp + tail.length;
    this.bestTotal = total;
  }

  private overBudget(): boolean {
    return this.nodes > this.maxNodes || performance.now() > this.deadline || this.mCount > this.maxMemo;
  }

  /**
   * Fail-soft windowed search. Returns f(R) exactly if f(R) > alpha, otherwise an upper bound <= alpha.
   * State: R, key, pathReward, stack. Letters of rank < rank0 have count 0.
   */
  solve(rank0: number, S1: number, S2: number, alpha: number): number {
    const R = this.R;
    const rl = this.rl;
    const nRank = this.nRank;
    let r = rank0;
    while (r < nRank && R[rl[r]!] === 0) r++;
    if (r === nRank) {
      if (this.pathReward > this.bestTotal) this.record();
      return 0;
    }
    const lim = this.bestTotal - this.pathReward;
    if (lim > alpha) alpha = lim;
    let ub = Math.floor((S1 < S2 ? S1 : S2) + 1e-6);
    if (ub <= alpha) return ub;
    if (this.memoOn) {
      const slot = this.find(this.key);
      if (slot >= 0) {
        const v = this.mVal[slot]!;
        if (this.mFlag[slot] === 2) {
          if (this.pathReward + v > this.bestTotal) this.recordWithTail();
          return v;
        }
        if (v <= alpha) return v;
        if (v < ub) ub = v;
      }
    }
    if ((++this.nodes & 63) === 0 && this.overBudget()) throw ABORT;

    const alpha0 = alpha;
    const D = this.dict;
    const L = rl[r]!;
    const { sigPairStart, pairLetter, pairCount } = D;
    const cSig = this.cSig;
    const cRew = this.cRew;
    const D1 = this.D1;
    const D2 = this.D2;
    let best = -1;
    let ubmax = -1;
    let choice = -2;
    const slackLow = this.slackLow;
    const cMask = this.cMask;
    let notR = ~0;
    for (let q = r; q < nRank; q++) if (R[rl[q]!]! > 0) notR &= ~(1 << rl[q]!);
    for (let t = this.bStart[L]!, tEnd = this.bStart[L + 1]!; t < tEnd; t++) {
      const j = this.bList[t]!;
      if ((cMask[j]! & notR) !== 0) continue;
      let eff = alpha0;
      if (best > eff) eff = best;
      const g = this.bestTotal - this.pathReward;
      if (g > eff) eff = g;
      // buckets are sorted by dual slack ascending => bound S1 - slackLow[j] is non-increasing: break
      const bk = Math.floor(S1 - slackLow[j]! + 1e-6);
      if (bk <= eff) {
        if (bk > ubmax) ubmax = bk;
        break;
      }
      const rew = cRew[j]!;
      const n1 = S1 - D1[j]!;
      const n2 = S2 - D2[j]!;
      const cub = rew + Math.floor((n1 < n2 ? n1 : n2) + 1e-6);
      if (cub <= eff) {
        if (cub > ubmax) ubmax = cub;
        continue;
      }
      const s = cSig[j]!;
      const p0 = sigPairStart[s]!;
      const p1 = sigPairStart[s + 1]!;
      let ok = true;
      for (let p = p0; p < p1; p++) {
        if (R[pairLetter[p]!]! < pairCount[p]!) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let p = p0; p < p1; p++) R[pairLetter[p]!]! -= pairCount[p]!;
      this.key -= this.cKey[j]!;
      this.pathReward += rew;
      this.stack[this.sp++] = j;
      const v = rew + this.solve(r, n1, n2, eff - rew);
      this.sp--;
      this.pathReward -= rew;
      this.key += this.cKey[j]!;
      for (let p = p0; p < p1; p++) R[pairLetter[p]!]! += pairCount[p]!;
      if (v > eff) {
        best = v;
        choice = j;
      } else if (v > ubmax) ubmax = v;
    }
    // option: no further word uses letter L (discard all remaining copies)
    {
      const nL = R[L]!;
      const n1 = S1 - nL * this.y1[L]!;
      const n2 = S2 - nL * this.y2[L]!;
      const cub = Math.floor((n1 < n2 ? n1 : n2) + 1e-6);
      let eff = alpha0;
      if (best > eff) eff = best;
      const g = this.bestTotal - this.pathReward;
      if (g > eff) eff = g;
      if (cub <= eff) {
        if (cub > ubmax) ubmax = cub;
      } else {
        R[L] = 0;
        this.key -= nL * this.stride[L]!;
        const v = this.solve(r + 1, n1, n2, eff);
        this.key += nL * this.stride[L]!;
        R[L] = nL;
        if (v > eff) {
          best = v;
          choice = -1;
        } else if (v > ubmax) ubmax = v;
      }
    }
    if (best > alpha0) {
      if (this.memoOn) this.store(this.key, true, best, choice);
      return best;
    }
    const ret = ubmax > best ? ubmax : best;
    const out = ret < 0 ? 0 : ret;
    if (this.memoOn) this.store(this.key, false, out, -2);
    return out;
  }

  /** Greedy incumbent. mode 0: highest reward first. mode 1: highest reward + dual-bound-of-rest. */
  greedy(mode: number): { stack: number[]; total: number } {
    const R = this.R.slice();
    const D = this.dict;
    const { sigPairStart, pairLetter, pairCount } = D;
    let [S1, S2] = this.rootSums();
    const out: number[] = [];
    let total = 0;
    for (;;) {
      let bestJ = -1;
      let bestV = -1;
      for (let j = 0; j < this.m; j++) {
        const s = this.cSig[j]!;
        let ok = true;
        for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
          if (R[pairLetter[p]!]! < pairCount[p]!) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (mode === 0) {
          bestJ = j;
          break;
        }
        const n1 = S1 - this.D1[j]!;
        const n2 = S2 - this.D2[j]!;
        const v = this.cRew[j]! + (n1 < n2 ? n1 : n2);
        if (v > bestV) {
          bestV = v;
          bestJ = j;
        }
      }
      if (bestJ < 0) break;
      const s = this.cSig[bestJ]!;
      for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) R[pairLetter[p]!]! -= pairCount[p]!;
      S1 -= this.D1[bestJ]!;
      S2 -= this.D2[bestJ]!;
      out.push(bestJ);
      total += this.cRew[bestJ]!;
    }
    return { stack: out, total };
  }
}

/**
 * Maximum-total-reward set of DISJOINT words spellable from the rack (not all letters need be
 * used). Exact branch-and-bound with a wall-clock budget; if the budget expires the best set found
 * so far is returned with optimal=false (it is always at least the better of two greedy plays).
 */
export function bestPartition(rack: Counts, opts: PartitionOpts = {}): PartitionResult {
  const tStart = performance.now();
  const useCache = opts.useCache !== false;
  const key = useCache ? countsKey(rack) : "";
  if (useCache) {
    const hit = PART_CACHE.get(key);
    if (hit) return { words: hit.words.slice(), total: hit.total, optimal: true, nodes: 0 };
  }
  const D = getDict();
  if (totalTiles(rack) < 2) return { words: [], total: 0, optimal: true, nodes: 0 };
  const sigs = playableSigs(rack, 2, 99);
  if (sigs.length === 0) return { words: [], total: 0, optimal: true, nodes: 0 };

  const solver = new PartitionSolver(D);
  if (!solver.setup(rack, sigs)) return { words: [], total: 0, optimal: true, nodes: 0 };
  solver.deadline = tStart + (opts.timeBudgetMs ?? 30);
  solver.maxNodes = opts.maxNodes ?? 4_000_000;
  if (solver.memoOn) solver.memoInit();

  // incumbent: better of two greedy plays
  const g0 = solver.greedy(0);
  const g1 = solver.greedy(1);
  const g = g1.total > g0.total ? g1 : g0;
  solver.bestTotal = g.total;
  solver.bestSp = g.stack.length;
  for (let i = 0; i < g.stack.length; i++) solver.bestStack[i] = g.stack[i]!;

  const [S1, S2] = solver.rootSums();
  let optimal = false;
  if (solver.bound(S1, S2) <= solver.bestTotal) {
    optimal = true;
  } else {
    try {
      solver.solve(0, S1, S2, solver.bestTotal);
      optimal = true;
    } catch (e) {
      if (e !== ABORT) throw e;
    }
  }

  const idx: number[] = [];
  for (let i = 0; i < solver.bestSp; i++) idx.push(solver.bestStack[i]!);
  idx.sort((a, b) => solver.cRew[b]! - solver.cRew[a]! || a - b);
  const words = idx.map((j) => D.words[D.sigWordStart[solver.cSig[j]!]!]!);
  const rootBound = solver.bound(S1, S2);
  const result: PartitionResult = {
    words,
    total: solver.bestTotal,
    optimal,
    nodes: solver.nodes,
    upperBound: optimal ? solver.bestTotal : Math.max(solver.bestTotal, rootBound),
  };
  if (optimal && useCache) {
    if (PART_CACHE.size >= PART_CACHE_MAX) PART_CACHE.clear();
    PART_CACHE.set(key, { words: words.slice(), total: solver.bestTotal, optimal: true });
  }
  return result;
}

export function clearPartitionCache(): void {
  PART_CACHE.clear();
}

/** Best-partition total for a rack (cached; small default budget). Handy as a valuation primitive. */
export function partitionValue(rack: Counts, timeBudgetMs = 5): number {
  return bestPartition(rack, { timeBudgetMs }).total;
}

export interface MarginalOpts {
  /**
   * Soft wall-clock budget for all solves (default 25 ms). Each solve gets an equal share of what is
   * left; once the budget is spent, remaining letters are NOT evaluated and keep the value NaN.
   * Pass Infinity to force every letter.
   */
  totalBudgetMs?: number;
  /** Per-solve cap for the search (default 5 ms; setup of a solve is not interruptible). */
  perSolveMs?: number;
  /** Letters with skip[c] > 0 are not evaluated (value 0). */
  skip?: Counts;
  /** Evaluate only these letter indices (0 = 'A'), in this order; others stay NaN. Default: all, A..Z. */
  letters?: number[];
}

/**
 * For each letter c: bestPartition(rack + c).total - bestPartition(rack).total (Float64Array(26);
 * NaN = not evaluated, see opts). Solves that exhaust their search budget return a best-found
 * (lower-bound) total, so with tight budgets individual gains are approximate; they are exact
 * whenever every solve proves optimality. For one letter use letterGain().
 */
export function marginalLetterGains(rack: Counts, opts: MarginalOpts = {}): Float64Array {
  const t0 = performance.now();
  const total = opts.totalBudgetMs ?? 25;
  const cap = opts.perSolveMs ?? 5;
  const out = new Float64Array(26).fill(NaN);
  const tmp = rack.slice();
  const letters = (opts.letters ?? Array.from({ length: 26 }, (_, i) => i)).filter((c) => !(opts.skip && opts.skip[c]! > 0));
  if (opts.skip) for (let c = 0; c < 26; c++) if (opts.skip[c]! > 0 && !opts.letters) out[c] = 0;
  let left = letters.length + 1;
  const solve = (r: Counts): number => {
    const remaining = Math.max(0.2, total - (performance.now() - t0));
    const b = Math.min(cap, remaining / left);
    left--;
    return bestPartition(r, { timeBudgetMs: b }).total;
  };
  const base = solve(rack);
  for (const c of letters) {
    if (performance.now() - t0 > total) break;
    tmp[c]!++;
    out[c] = solve(tmp) - base;
    tmp[c]!--;
  }
  return out;
}

/** bestPartition(rack + letter).total - bestPartition(rack).total for one letter index (0 = 'A'). */
export function letterGain(rack: Counts, letter: number, timeBudgetMs = 5): number {
  const base = bestPartition(rack, { timeBudgetMs }).total;
  const r2 = rack.slice();
  r2[letter]!++;
  return bestPartition(r2, { timeBudgetMs }).total - base;
}

// ---------------------------------------------------------------------------------------------
// bestPlayWithLeave
// ---------------------------------------------------------------------------------------------

export interface PlayWithLeaveOpts {
  /** Wall-clock budget (default 15 ms). */
  timeBudgetMs?: number;
  /** Max words in one play (default 3). */
  maxWords?: number;
  /** Candidate pool size per ordering (by reward, by reward-per-tile); default 48. */
  poolSize?: number;
  /** Max number of distinct leaves passed to leaveValue (default 3000). */
  maxEvals?: number;
  /** Min word length (default 2). */
  minLen?: number;
}

export interface PlayWithLeaveResult {
  words: string[];
  reward: number;
  leave: Counts;
  /** reward + leaveValue(leave) for the chosen play. */
  value: number;
  /** leaveValue(leave) for the chosen play. */
  leaveValue: number;
  /** Number of distinct leaves evaluated. */
  evals: number;
  /** True if the whole (pool x maxWords) space was enumerated within budget. */
  complete: boolean;
  /** True if the playable-word pool was truncated to poolSize. */
  poolTruncated: boolean;
}

/**
 * Choose a set of disjoint words to play NOW maximising reward + leaveValue(leave), where leave is
 * the rack after the play. Playing nothing is always considered. leaveValue is called once per
 * distinct leave with a fresh Counts it may keep. Candidate sets are enumerated best-reward-first
 * from a pool (top by reward and top by reward-per-tile) and always include the max-reward
 * partition, so the result is never worse than "play the best partition" or "play nothing".
 */
export function bestPlayWithLeave(
  rack: Counts,
  leaveValue: (leave: Counts) => number,
  opts: PlayWithLeaveOpts = {},
): PlayWithLeaveResult {
  const D = getDict();
  const t0 = performance.now();
  const budget = opts.timeBudgetMs ?? 15;
  const maxWords = opts.maxWords ?? 3;
  const poolSize = opts.poolSize ?? 48;
  const maxEvals = opts.maxEvals ?? 3000;
  const minLen = opts.minLen ?? 2;
  const deadline = t0 + budget;

  interface Entry {
    reward: number;
    words: string[];
    lv: number;
    leave: Counts;
  }
  const seen = new Map<string, Entry>();
  let evals = 0;
  let stop = false;
  let best: Entry | null = null;
  let bestVal = -Infinity;

  const consider = (e: Entry): void => {
    const v = e.reward + e.lv;
    if (v > bestVal || (v === bestVal && best !== null && e.reward > best.reward)) {
      best = e;
      bestVal = v;
    }
  };

  const evalLeave = (leave: Counts, rew: number, wordList: string[]): void => {
    const k = countsKey(leave);
    const prev = seen.get(k);
    if (prev) {
      if (rew > prev.reward) {
        prev.reward = rew;
        prev.words = wordList.slice();
        if (best === prev) bestVal = prev.reward + prev.lv;
        consider(prev);
      }
      return;
    }
    const lv = leaveValue(leave.slice());
    evals++;
    const e: Entry = { reward: rew, words: wordList.slice(), lv, leave: leave.slice() };
    seen.set(k, e);
    consider(e);
  };

  // play nothing
  evalLeave(rack, 0, []);

  const sigs = playableSigs(rack, minLen, 99);
  let poolTruncated = false;
  let complete = true;
  if (sigs.length > 0 && maxWords > 0) {
    const { sigReward, sigLen, sigPairStart, pairLetter, pairCount, words, sigWordStart } = D;
    const byReward = sigs.slice().sort((a, b) => sigReward[b]! - sigReward[a]! || a - b);
    const eff = (s: number): number => sigReward[s]! / sigLen[s]!;
    const byEff = sigs.slice().sort((a, b) => eff(b) - eff(a) || sigReward[b]! - sigReward[a]! || a - b);
    const picked = new Set<number>();
    for (let i = 0; i < Math.min(poolSize, byReward.length); i++) picked.add(byReward[i]!);
    for (let i = 0; i < Math.min(poolSize, byEff.length); i++) picked.add(byEff[i]!);
    poolTruncated = picked.size < sigs.length;
    const pool = byReward.filter((s) => picked.has(s));

    const cur = rack.slice();
    const stackW: string[] = [];

    // seed with the max-reward partition (cheap budget)
    const part = bestPartition(rack, { timeBudgetMs: Math.min(4, budget / 3) });
    if (part.words.length > 0 && part.words.length <= 12) {
      const tmp = rack.slice();
      let rew = 0;
      let ok = true;
      for (const w of part.words) {
        for (let i = 0; i < w.length; i++) {
          const k = w.charCodeAt(i) - CODE_A;
          if (tmp[k]! <= 0) ok = false;
          else tmp[k]!--;
        }
        rew += reward(w);
      }
      if (ok) evalLeave(tmp, rew, part.words);
    }

    let tick = 0;
    const rec = (start: number, nWords: number, rew: number): void => {
      if (stop) return;
      if (nWords > 0) {
        evalLeave(cur, rew, stackW);
        if (evals >= maxEvals || ((++tick & 15) === 0 && performance.now() > deadline)) {
          stop = true;
          return;
        }
      }
      if (nWords >= maxWords) return;
      for (let i = start; i < pool.length; i++) {
        const s = pool[i]!;
        let ok = true;
        for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
          if (cur[pairLetter[p]!]! < pairCount[p]!) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) cur[pairLetter[p]!]! -= pairCount[p]!;
        stackW.push(words[sigWordStart[s]!]!);
        rec(i, nWords + 1, rew + sigReward[s]!);
        stackW.pop();
        for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) cur[pairLetter[p]!]! += pairCount[p]!;
        if (stop) return;
      }
    };
    rec(0, 0, 0);
    complete = !stop;
  }

  const b = best as Entry | null;
  if (!b) throw new Error("bestPlayWithLeave: no candidate evaluated");
  return {
    words: b.words.slice().sort((x, y) => reward(y) - reward(x) || (x < y ? -1 : 1)),
    reward: b.reward,
    leave: b.leave.slice(),
    value: b.reward + b.lv,
    leaveValue: b.lv,
    evals,
    complete,
    poolTruncated,
  };
}

// ---------------------------------------------------------------------------------------------
// Completion / near-word statistics
// ---------------------------------------------------------------------------------------------

export interface LenRange {
  minLen?: number; // default 2
  maxLen?: number; // default unlimited
}

export interface CompletionTable {
  minLen: number;
  maxLen: number;
  /** words[c]: number of words (anagram variants counted) of length in range NOT spellable now but spellable after adding one `c`. */
  words: Int32Array;
  /** sigs[c]: same, counted per anagram class. */
  sigs: Int32Array;
  /** bestReward[c]: highest reward among those newly spellable words (0 if none). */
  bestReward: Int32Array;
  /** sumReward[c]: sum of rewards of those words (anagram variants counted). */
  sumReward: Float64Array;
}

function newTable(minLen: number, maxLen: number): CompletionTable {
  return {
    minLen,
    maxLen,
    words: new Int32Array(26),
    sigs: new Int32Array(26),
    bestReward: new Int32Array(26),
    sumReward: new Float64Array(26),
  };
}

/**
 * One scan, several length thresholds. For each minLen in `minLens` returns a table giving, per
 * candidate letter c, which words of length >= minLen (and <= maxLen) become spellable when one
 * tile `c` is added to the rack (deficiency exactly 1, at letter c).
 */
export function completionTables(rack: Counts, minLens: number[] = [4, 5, 7], maxLen = 99): CompletionTable[] {
  const D = getDict();
  const tables = minLens.map((m) => newTable(m, maxLen));
  const lo = Math.max(2, Math.min(...minLens));
  const hi = Math.min(maxLen, D.maxLen);
  const rackMask = rackMaskOf(rack);
  const { sigMask, sigPairStart, pairLetter, pairCount, sigByLen, lenStart, sigReward, sigWordStart, sigLen } = D;
  const from = lenStart[lo]!;
  const to = lenStart[Math.min(hi, D.maxLen) + 1]!;
  for (let q = from; q < to; q++) {
    const s = sigByLen[q]!;
    const miss = sigMask[s]! & ~rackMask;
    if ((miss & (miss - 1)) !== 0) continue; // 2+ distinct letters missing
    let def = 0;
    let missL = -1;
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const L = pairLetter[p]!;
      const d = pairCount[p]! - rack[L]!;
      if (d > 0) {
        def += d;
        missL = L;
        if (def > 1) break;
      }
    }
    if (def !== 1) continue;
    const len = sigLen[s]!;
    const nw = sigWordStart[s + 1]! - sigWordStart[s]!;
    const rw = sigReward[s]!;
    for (let t = 0; t < tables.length; t++) {
      const tb = tables[t]!;
      if (len < tb.minLen) continue;
      tb.words[missL]! += nw;
      tb.sigs[missL]!++;
      if (rw > tb.bestReward[missL]!) tb.bestReward[missL] = rw;
      tb.sumReward[missL]! += rw * nw;
    }
  }
  return tables;
}

export function completionTable(rack: Counts, opts: LenRange = {}): CompletionTable {
  return completionTables(rack, [opts.minLen ?? 7], opts.maxLen ?? 99)[0]!;
}

export interface NearWord {
  word: string; // lexicographically smallest anagram
  anagrams: number;
  len: number;
  reward: number;
  missing: number; // tiles that must be added
  missingLetters: string; // sorted, e.g. "EQ"
}

export interface NearWordsOpts extends LenRange {
  maxMissing?: number; // default 1
  limit?: number; // default 50 (sorted by missing asc, reward desc, len asc, word asc)
}

/** Words of length in range needing at most `maxMissing` extra tiles, best-first. */
export function nearWords(rack: Counts, opts: NearWordsOpts = {}): NearWord[] {
  const D = getDict();
  const lo = Math.max(2, opts.minLen ?? 2);
  const hi = Math.min(opts.maxLen ?? 99, D.maxLen);
  const maxMissing = opts.maxMissing ?? 1;
  const limit = opts.limit ?? 50;
  const rackMask = rackMaskOf(rack);
  const { sigMask, sigPairStart, pairLetter, pairCount, sigByLen, lenStart, sigReward, sigLen } = D;
  const hits: number[] = [];
  const defs: number[] = [];
  for (let q = lenStart[lo]!, to = lenStart[hi + 1]!; q < to; q++) {
    const s = sigByLen[q]!;
    const miss = sigMask[s]! & ~rackMask;
    if (miss !== 0 && popcount32(miss) > maxMissing) continue;
    let def = 0;
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const d = pairCount[p]! - rack[pairLetter[p]!]!;
      if (d > 0) {
        def += d;
        if (def > maxMissing) break;
      }
    }
    if (def > maxMissing) continue;
    hits.push(s);
    defs.push(def);
  }
  const order = hits.map((_, i) => i);
  order.sort(
    (a, b) =>
      defs[a]! - defs[b]! ||
      sigReward[hits[b]!]! - sigReward[hits[a]!]! ||
      sigLen[hits[a]!]! - sigLen[hits[b]!]! ||
      hits[a]! - hits[b]!,
  );
  const out: NearWord[] = [];
  for (let i = 0; i < Math.min(limit, order.length); i++) {
    const s = hits[order[i]!]!;
    let ml = "";
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const L = pairLetter[p]!;
      const d = pairCount[p]! - rack[L]!;
      if (d > 0) ml += String.fromCharCode(CODE_A + L).repeat(d);
    }
    out.push({
      word: D.words[D.sigWordStart[s]!]!,
      anagrams: D.sigWordStart[s + 1]! - D.sigWordStart[s]!,
      len: sigLen[s]!,
      reward: sigReward[s]!,
      missing: defs[order[i]!]!,
      missingLetters: ml,
    });
  }
  return out;
}

export interface MinMissingResult {
  /** Fewest tiles that must be added to spell SOME word of length in range (0 = already spellable). */
  missing: number;
  /** Number of anagram classes / words at that minimum deficiency. */
  sigs: number;
  words: number;
  /** Highest reward among words at the minimum deficiency. */
  bestReward: number;
  /** For missing >= 1: letterWords[c] = number of min-deficiency words that need letter c (counted once per word). */
  letterWords: Int32Array;
  /** Up to 8 best examples at the minimum deficiency. */
  examples: NearWord[];
}

/** How close is the rack to a word of length in [minLen, maxLen] (default 7+): exact min missing tiles. */
export function minMissing(rack: Counts, opts: LenRange = {}): MinMissingResult {
  const D = getDict();
  const lo = Math.max(2, opts.minLen ?? 7);
  const hi = Math.min(opts.maxLen ?? 99, D.maxLen);
  const rackMask = rackMaskOf(rack);
  const { sigMask, sigPairStart, pairLetter, pairCount, sigByLen, lenStart, sigReward, sigWordStart, sigLen } = D;
  let bestDef = 99;
  let hits: number[] = [];
  for (let q = lenStart[lo]!, to = lenStart[hi + 1]!; q < to; q++) {
    const s = sigByLen[q]!;
    const miss = sigMask[s]! & ~rackMask;
    if (miss !== 0 && popcount32(miss) > bestDef) continue;
    let def = 0;
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const d = pairCount[p]! - rack[pairLetter[p]!]!;
      if (d > 0) {
        def += d;
        if (def > bestDef) break;
      }
    }
    if (def > bestDef) continue;
    if (def < bestDef) {
      bestDef = def;
      hits = [];
    }
    hits.push(s);
  }
  const letterWords = new Int32Array(26);
  let words = 0;
  let bestReward = 0;
  for (const s of hits) {
    words += sigWordStart[s + 1]! - sigWordStart[s]!;
    if (sigReward[s]! > bestReward) bestReward = sigReward[s]!;
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const L = pairLetter[p]!;
      if (pairCount[p]! > rack[L]!) letterWords[L]!++;
    }
  }
  const ex = hits.slice().sort((a, b) => sigReward[b]! - sigReward[a]! || sigLen[a]! - sigLen[b]! || a - b).slice(0, 8);
  const examples: NearWord[] = ex.map((s) => {
    let ml = "";
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const L = pairLetter[p]!;
      const d = pairCount[p]! - rack[L]!;
      if (d > 0) ml += String.fromCharCode(CODE_A + L).repeat(d);
    }
    return {
      word: D.words[sigWordStart[s]!]!,
      anagrams: sigWordStart[s + 1]! - sigWordStart[s]!,
      len: sigLen[s]!,
      reward: sigReward[s]!,
      missing: bestDef,
      missingLetters: ml,
    };
  });
  return { missing: bestDef === 99 ? -1 : bestDef, sigs: hits.length, words, bestReward, letterWords, examples };
}

/**
 * Histogram of deficiency: result[k] = number of words (anagram variants counted) of length in range
 * that need exactly k more tiles, for k = 0..maxK. Words needing more than maxK are not counted.
 */
export function deficiencyHistogram(rack: Counts, opts: LenRange & { maxK?: number } = {}): Int32Array {
  const D = getDict();
  const maxK = opts.maxK ?? 3;
  const lo = Math.max(2, opts.minLen ?? 7);
  const hi = Math.min(opts.maxLen ?? 99, D.maxLen);
  const rackMask = rackMaskOf(rack);
  const { sigMask, sigPairStart, pairLetter, pairCount, sigByLen, lenStart, sigWordStart } = D;
  const out = new Int32Array(maxK + 1);
  for (let q = lenStart[lo]!, to = lenStart[hi + 1]!; q < to; q++) {
    const s = sigByLen[q]!;
    const miss = sigMask[s]! & ~rackMask;
    if (miss !== 0 && popcount32(miss) > maxK) continue;
    let def = 0;
    for (let p = sigPairStart[s]!, e = sigPairStart[s + 1]!; p < e; p++) {
      const d = pairCount[p]! - rack[pairLetter[p]!]!;
      if (d > 0) {
        def += d;
        if (def > maxK) break;
      }
    }
    if (def > maxK) continue;
    out[def]! += sigWordStart[s + 1]! - sigWordStart[s]!;
  }
  return out;
}
