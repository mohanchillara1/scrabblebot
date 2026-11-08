# adversary notes
- 20:20 wrote src/strategies/adversary.ts (tuned engine + target-rack denial snipe + Vickrey shadow push). typecheck ok.
- 20:25 sim n=400 6p vs tuned field: deny/push give ZERO damage to tuned (76.75 vs 76.50 ctrl), push costs adversary -4.7. Heads-up push=1.0,tmult=1.0,cap .3,minFrac .3: adversary 274.6 vs tuned 213.7 (n=300, seed 91), win 76%.
- 20:30 heads-up fresh seed123 (profile 2p): vs tuned 278.0 v 210.1 win 81%; topbot-like 260 v 231; mcvalue 265 v 209 n80; economist 279 v 219 n31

## Final (20:33) — src/strategies/adversary.ts (registered as "adversary"; tuned engine + attack layer)
Verified (ran, nice -n 19, one process at a time, Vickrey unless noted):
- 6p vs field tuned,topbot-like x2,mid-bot x2, seed 77, n=400: control (attacks off = tuned clone) adversary 76.78, tuned 76.50.
  Full attack: adversary 72.08 (-4.7), tuned 76.75 (+0.25 +-1.2) => price push does ZERO damage and costs me. deny-only: tuned 76.47 (no effect;
  denial fired 66x in 200 matches, raised the bid 45x). Both are therefore OFF at 4+ players for push; deny stays (neutral).
- 3p (tuned, topbot-like) seed 55, n=250: push off adv 151.4 / tuned 152.0; push on adv 152.4 / tuned 152.8: neutral. Push off at 3p.
- HEADS-UP (2p) vs tuned: bid = max(tuned-engine bid, going rate (EMA of paid) x shape) when engine bid >= 0.3 x that, capped 30% of balance.
  Tuned on seed 91: 274.6 v 213.7 (n=300). Fresh seed 123 with final profile: adversary 278.0 +-2.6 v tuned 210.1 +-2.4, win 81.3% +-2.3.
  Same code vs topbot-like 260.4 v 230.9 (n=300, win 62.7%), vs mcvalue 265.1 v 208.8 (n=80, win 66%), vs economist 278.7 v 218.7 (n=31, win 68%).
  Mechanism (diag, n=100): adversary wins 49.3 tiles at $6.3, tuned 37.7 tiles at $7.5; adversary ends with 69.6 coins unspent => more headroom.
  push=1.2 collapses to parity (237 v 249) because the going-rate EMA includes my own bids (self-reference runaway): sweet spot 0.9-1.1.
- FirstPrice 2p/6p: parity with tuned (push is Vickrey-only), no exploit found.
- Live-log calibration (4311 auctions, 45 matches, rot-*.log + practice*.log): mean paid by letter value 1:10.9 2:12.9 3:16.3 4:18.6 5:22.7 8:29.2 10:30.2;
  by round 1-10: 14.6, 11-20: 13.8, 21-30: 13.4, 31-40: 13.0, 41-50: 12.8, 51-60: 12.9, 61-70: 11.2. Top winner holds 25% of tiles per match (flat field).
  The live runner log prints bid=- and a final bal/score on every line, so our own bids are not recoverable from the logs.
