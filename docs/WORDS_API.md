# Word engine API (`src/engine/words.ts`)

Import: `import * as W from "../engine/words.js";` (extensionless/`.js` both resolve under tsx; module resolution is `Bundler`).

Everything is synchronous and exact unless a function says it has a time budget. The dictionary
(`data/wordlist.txt`, 172,820 words) is a lazy singleton located relative to the module file
(`import.meta.url`), so cwd does not matter. First use pays a one-off load of about 330-410 ms and
about 100 MB RSS; call `W.warmUp()` at startup to take that hit outside a live auction.

**Wordlist facts that bite:** it has no `QI`, no `ZA` (it has `JO`, `XU`, `OXO`). Do not assume a
Collins/NWL short-word set; ask `W.isWord`.

Rack representation: `type Counts = Uint8Array` of length 26 (index 0 = `A`). All functions take a
`Counts` and never mutate it (the one exception to "never keeps a reference": `leaveValue` callbacks
get their own copy).

## Basics

| function | notes |
|---|---|
| `rackToCounts(Map<string,number>)` | the `MatchView.myRack` -> Counts. Non A-Z keys ignored. |
| `countsToMap(Counts)` | back to a Map (only letters with count > 0). |
| `wordToCounts(str)`, `countsToString(Counts)` | `"AEINRST"` <-> Counts (string is sorted letters). |
| `letterValue(ch)` | 0 for anything but uppercase A-Z (same as server `letters.ts`). `LETTER_VALUES[i]` by index. |
| `reward(word)` | `floor(base*num/den)` exactly as the server (BigInt-checked against every dictionary word in the tests). Does **not** check the dictionary. `rewardFromBase(base,len)` is the underlying formula. |
| `isWord(word)` | any case; >= 2 letters, A-Z only, in the wordlist (same rule as `submit_word`). |
| `canSpell(rack, word)`, `subtractWord(rack, word)` | |
| `totalTiles(c)`, `tileValue(c)` | tile count / sum of letter values. |
| `countsKey(c)` | exact 13-char string key (counts <= 255) for your own Maps. |
| `BAG_COUNTS` | the 98-tile bag (index 0 = A). |
| `warmUp()`, `wordCount()`, `allWords()`, `dictionaryPath()` | |

## Single words

* `playableWords(rack, {minLen?, maxLen?}): string[]` - every dictionary word spellable from the
  rack, **exact**. Order is sorted-letter (anagram class) order, not alphabetical; anagrams of one
  class are contiguous and alphabetical inside the class. `countPlayable(rack, opts)` and
  `playableByLength(rack): Int32Array` (index = word length) avoid building the array.
* `playableSigs(rack, minLen?, maxLen?): number[]` - the same at anagram-class level (internal ids;
  mostly for building other engines).
* `bestWord(rack, {minLen?}): {word, reward} | null` - max reward; ties go to fewer tiles, then
  alphabetically smaller. (`minLen` defaults to 2.)

## Disjoint-word sets

* `bestPartition(rack, {timeBudgetMs?=30, maxNodes?=4e6, useCache?=true}): {words, total, optimal, nodes?, upperBound?}`
  Maximum-total-reward set of **disjoint** dictionary words from the rack (letters may be left over;
  the same word may appear twice if you hold the letters twice). Branch-and-bound over count vectors
  with an exact memo, an LP-dual upper bound and a greedy incumbent.
  * `optimal: true` is a proof. `false` means the budget ran out; `total` is the best set found
    (never worse than two greedy plays) and `upperBound` is a proven ceiling.
  * `words` are sorted by descending reward. `total` = sum of `reward(word)`.
  * Only optimal results are cached (cross-call, keyed by the exact rack, cleared at 60k entries,
    `clearPartitionCache()`); a cache hit returns immediately and ignores the budget.
  * The budget clock starts at call entry, but candidate setup (about 0.3-8 ms depending on the
    number of playable words) is not interruptible, so a 5 ms budget can take up to about 12 ms.
  * Per-letter counts above 31 are clamped to 31 for the memo key (impossible in the real bag, max 12).
* `partitionValue(rack, timeBudgetMs=5): number` - `bestPartition(...).total`, a valuation primitive.
* `letterGain(rack, letterIndex, budget=5)` - `partitionValue(rack+letter) - partitionValue(rack)`.
* `marginalLetterGains(rack, {totalBudgetMs?=25, perSolveMs?=5, skip?, letters?}): Float64Array(26)`
  - gain of every possible next letter. Once the soft total budget is spent the remaining letters are
  **NaN** (not evaluated); pass `totalBudgetMs: Infinity` for all 26 (about 1.5 ms at 7 tiles, 4.7 ms at
  12, 14.5 ms at 16, 38 ms at 20 tiles). Use `skip` (letters whose bag supply is exhausted) or
  `letters` to cut work. Gains from budget-limited solves are approximate.

## Play now vs keep (leave valuation)

`bestPlayWithLeave(rack, leaveValue: (leave: Counts) => number, opts?)`

Returns `{words, reward, leave, value, leaveValue, evals, complete, poolTruncated}` where
`value = reward + leaveValue(leave)` is maximised over "play nothing" and every set of up to
`maxWords` (default 3) disjoint words drawn from a pool. The pool is the top `poolSize` (default 48)
playable words by reward unioned with the top `poolSize` by reward-per-tile, and the max-reward
partition is always evaluated as a seed. `leaveValue` is called once per **distinct** leave (not per
word set) with a fresh copy it may keep, so it can be expensive or call back into the engine (it is
re-entrant). Other opts: `timeBudgetMs` (15), `maxEvals` (3000), `minLen` (2).
`complete: true` means the whole (pool x maxWords) space was enumerated within budget;
`poolTruncated: true` means some playable words were not in the pool. For a guaranteed-exhaustive
search on a small rack pass `poolSize: 1e9, maxEvals: 1e9`. With `leaveValue = () => 0` and a large
`maxWords` it equals `bestPartition().total` (tested).

## Completion statistics (marginal-letter valuation)

All are linear scans over anagram classes with a 26-bit letter-mask prefilter (0.2-4 ms).
"Deficiency" of a word = number of extra tiles needed to spell it from the rack.

* `completionTables(rack, minLens=[4,5,7], maxLen?)` / `completionTable(rack, {minLen,maxLen})`
  -> per threshold a `CompletionTable` with, for each candidate letter `c`: `words[c]` (words of
  length >= minLen that are NOT spellable now but ARE after adding one `c`, anagram variants counted),
  `sigs[c]` (anagram classes), `bestReward[c]`, `sumReward[c]`. This is "how many 7+/5+/4+ words does
  letter c unlock". Multiply by the bag supply of `c` yourself.
* `minMissing(rack, {minLen=7, maxLen?})` -> `{missing, sigs, words, bestReward, letterWords, examples}`:
  the exact minimum number of tiles to add to spell some word of that length range (0 = already
  spellable, -1 = none exist), how many words sit at that minimum, `letterWords[c]` = how many of
  them need `c`, and up to 8 best examples (`NearWord`).
* `nearWords(rack, {minLen, maxLen, maxMissing=1, limit=50})` -> `NearWord[]`
  `{word, anagrams, len, reward, missing, missingLetters}` sorted by missing asc, reward desc.
  (Sorting cost grows with the hit count; keep `maxMissing` small on small racks.)
* `deficiencyHistogram(rack, {minLen=7, maxLen, maxK=3})` -> `Int32Array(maxK+1)`, words needing
  exactly k tiles (k = 0..maxK).

## Measured performance (this laptop, `nice -n 19`, N=150-300 random bag racks per row)

Run `nice -n 19 timeout 200 npx tsx src/engine/bench.ts [N] [section]`. SE = standard error of the mean.

| call | rack | mean +- SE (ms) | p50 | p99 | max |
|---|---|---|---|---|---|
| dictionary load (once) | - | about 330-410 | | | |
| `playableWords` | 7 | 0.004 +- 0.000 | 0.004 | 0.011 | 0.045 |
| | 12 | 0.027 +- 0.002 | 0.022 | 0.109 | 0.396 |
| | 20 | 0.221 +- 0.010 | 0.178 | 0.944 | 1.46 |
| | 25 | 0.555 +- 0.024 | 0.441 | 2.47 | 2.99 |
| `bestWord` | 7 / 12 / 20 | 0.004 / 0.018 / 0.061 | | 0.014 / 0.064 / 0.279 | 0.5 |
| `bestPartition` (budget 50) | 10 | 0.146 +- 0.008 | 0.123 | 0.515 | 0.516 |
| | 15 | 0.522 +- 0.041 | 0.360 | 2.42 | 2.84 |
| | 20 | 2.01 +- 0.16 | 1.39 | 8.79 | 12.6 |
| | 25 | 5.11 +- 0.57 | 3.16 | 50.1 | 50.3 |
| `bestPartition` (budget 5) | 20 / 25 | 1.67 / 3.10 | 1.15 / 2.83 | 5.19 / 7.07 | 5.3 / 8.7 |
| `bestPlayWithLeave` (cheap leave fn) | 7 / 12 / 20 | 0.21 / 0.44 / 2.84 | 0.13 / 0.35 / 2.25 | 1.6 / 1.5 / 10.0 | 11.8 |
| `completionTables([4,5,7])` | 7 / 12 / 20 | 0.49 / 0.60 / 1.73 | | 3.0 / 1.7 / 7.8 | 9.2 |
| `minMissing(7+)` | 7 / 12 / 20 | 0.52 / 0.40 / 0.85 | | 4.4 / 1.9 / 8.0 | 9.4 |
| `nearWords(7-8, 1 missing)` | 7 / 12 / 20 | 0.17 / 0.31 / 1.45 | | 0.9 / 1.6 / 5.6 | 6.3 |

`bestPartition` proved optimality in 100% of 150 racks at 10, 15 and 20 tiles (budget 50 ms), 99% at 25
tiles (budget 50 ms), and 93% / 85% at 20 / 25 tiles with only a 5 ms budget. Mean optimal totals:
39.4 +- 0.8 (10 tiles), 75.5 +- 1.1 (15), 107.2 +- 1.5 (20), 140.5 +- 1.8 (25). Root LP-dual bound is
about 5% above the optimum on average at 20 tiles; the plain greedy play is about 5% below it.

Numbers include JIT warm-up for the first calls only; later calls in a long-lived process are at or
below these figures.

## Correctness evidence (`node --import tsx --test src/engine/words.test.ts`, 18 tests)

Verified by running them (independent brute force that re-reads the wordlist):
* `reward` == BigInt formula for all 172,820 words; `isWord`, rack helpers.
* `playableWords`/`countPlayable`/`playableByLength` == brute force on 600 random racks (sizes 3..20),
  also with `minLen`/`maxLen`; `bestWord` == brute force on 600 racks x 2 `minLen`s.
* `bestPartition` == exhaustive set-packing on 300 racks (3..9 tiles); == independent memoised DP on
  160 racks (10..14 tiles); additionally (ad-hoc, not in the test file because of runtime) == the same DP
  on 60 racks at 16 and 60 racks at 18 tiles, 0 mismatches. Results are validated (disjoint, real words,
  total == sum of rewards) on 120 racks of 15..25 tiles and with a 0.01 ms budget.
* `bestPlayWithLeave` == brute-force enumeration of all <= 3-word plays with a nonlinear leave function
  on 60 racks; zero leave value == `bestPartition` on 80 racks; re-entrancy.
* `completionTables`, `minMissing`, `nearWords`, `deficiencyHistogram` == brute force on 60 racks.

## Design notes (for maintainers)

* Words are grouped into anagram classes (156,473 of them); a multiset trie (402,716 nodes, CSR,
  BFS node ids) over the sorted letters drives `playableWords`/`bestWord`; subtree max-reward and
  max-length annotations prune `bestWord` and length-filtered queries.
* `bestPartition` branches on the lowest-ranked rack letter (rarest in the candidate set first):
  either a word containing it, or "no further word uses it" (drop all copies). States are memoised on
  an exact mixed-radix key of the remaining counts in an open-addressing table; search uses fail-soft
  windows. The bound is `sum_c y_c * remaining_c` with `y` LP-dual feasible (equal-split and
  value-split starts, then coordinate descent), so a child's bound is `S - slack_j` and candidate lists
  are pre-sorted by slack and cut off at the first prunable candidate.
