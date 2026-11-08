# words worker notes (src/engine/**)

- 18:20 CT: read GAME_SPEC, types.ts, upstream letters.ts/dictionary.ts/game.ts playWord. Wordlist = 172,820 uppercase A-Z words, len 2..28.
- Plan: multiset (sorted-letter) trie, CSR layout, built once; signatures (anagram classes) carry reward/mask/counts.
  playableWords = trie DFS over remaining counts. bestWord = same DFS with subtree max-reward pruning.
  bestPartition = DP over count-vectors branching on lowest-rank letter (word containing it, or discard all copies),
  alpha-style windows, exact memo (mixed-radix key), LP-dual (coordinate descent) upper bound, greedy incumbent, time budget.
  near-word helpers = linear scan over signatures with 26-bit letter-mask prefilter.
- 18:50 CT: src/engine/words.ts written (~1100 lines) + words.test.ts (17 tests, all pass, typecheck clean). VERIFIED:
  playableWords/bestWord == brute force on 600 random racks (3..20); bestPartition == exhaustive on 300 racks (3..9) and ==
  independent memo-DP on 160 racks (10..14); bestPlayWithLeave == brute-force <=3-word enumeration on 60 racks; completion helpers == brute force.
  NOTE: wordlist has NO "QI"/"ZA" (has JO, XU, OXO) -- do not assume Collins/NWL2018 short words.
  Dictionary load ~360 ms, 156,473 anagram classes, 402,716 trie nodes.
- Next: bench.ts perf numbers, WORDS_API.md.
- 19:35 CT: DONE. All verified by running (nice -n 19, one process, < 200 s each):
  * tests: `nice -n 19 node --import tsx --test src/engine/words.test.ts` -> 18/18 pass (~13 s). `npx tsc --noEmit -p .` clean.
  * extra ad-hoc cross-check (not in test file, runtime): bestPartition == independent memo-DP on 60 racks @16 tiles and 60 @18 tiles, 0 mismatches.
  * perf (bench.ts): playableWords p99 0.011/0.109/0.944 ms @7/12/20 tiles; bestWord p99 <= 0.28 ms @20;
    bestPartition budget50 p99 0.5/2.4/8.8/50.1 ms @10/15/20/25 (optimal 100/100/100/99%); mean total @20 = 107.2 +- 1.5.
    marginalLetterGains all-26: mean 1.5/4.7/14.5/38 ms @7/12/16/20 tiles (so only use all-26 on small racks or with a budget; letterGain for one letter).
  * load 330-410 ms, ~100 MB RSS.
  * partition speedups that mattered: (1) buckets sorted by dual slack + break at first prunable candidate, (2) letter-mask prefilter before fit check (2x).
    Root LP-dual gap ~5% at 20 tiles; coordinate-descent dual can be loose on consonant-heavy racks (e.g. root bound 120 vs optimum 90), still solved in ~13 ms.
- Wordlist has NO "QI" / "ZA" (has JO, XU, OXO). Any strategy assuming Scrabble short words must call W.isWord.
- Not done / limits: bestPartition candidate setup (~0.3-8 ms) is not interruptible; memo cap 700k entries -> abort with best-so-far;
  per-letter count > 31 clamped in partition memo key (real bag max is 12).
- Not committed (hard rule 2): orchestrator commits. NOTE for the commit: CLAUDE.md rule 7 says commits that reach GitHub carry
  author+committer Mohan Chillara <mohan.kchill@gmail.com> and NO "Co-Authored-By: Claude" / Claude-Session trailers; run
  `git log --format='%an <%ae> | %cn <%ce>%n%b' | grep -i claude` before any push (expect nothing).
