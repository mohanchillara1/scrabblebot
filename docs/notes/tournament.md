# tournament worker notes (label: tournament) - running log

- 19:47 CT started (actual wall clock; brief said 18:12). Deadline 20:15.
- Plan: chain script sim-out/tournament/run_all.sh runs 14 sequential nice-19 runs (<=80 s each) -> sim-out/tournament/*.json/*.txt;
  sim-out/tournament/aggregate.py builds tables.md; docs/TOURNAMENT.md is written from it.
- 19:52 A1 (6p Vickrey Swiss, seed 4101, 115 matches): economist 91.0, tuned 80.2, mcvalue 78.0, topbot-like 74.7. No errors.
- Live log check (947 auctions, practice logs): value-1 letters clear at 10.7 in every round bucket (10.2-11.1), value-2 ~12-14, value-3 ~15-18, value-4 ~18-21, value>=8 ~30. Flat across the match, matches research/OPPONENTS.md.
- 20:18 wrote docs/TOURNAMENT.md final (C4-C6 completed).
