# audit-regression notes

## Status at 21:31 CT: NOT RUN (deadline already passed when this worker started)

- Hard deadline in the brief: return by 21:30 CT. `date` on first call read 21:30:56 CT, so the deadline was
  already missed at spawn. The brief's text said "now roughly 18:12 CT", which was stale.
- No simulations were run by this worker. No fresh-seed table exists. Nothing in this file is a result.
- Files touched: this notes file only. No source, no tests, no git commands.

## Plan if the orchestrator re-dispatches with a new deadline

CLI: `nice -n 19 timeout 200 npx tsx src/sim/run.ts --test <a,b,..> --field <self|mixed|starters> --matches N --seed S --auction <Vickrey|FirstPrice> --players P --max-seconds 170 --out sim-out/audit/<name>.json`
Strategies to name (verify with `--list`): final, economist, tuned, mcvalue, adversary, plus baselines.
Seeds already used by earlier work (avoid): 301, 311-314, 363, 364 and anything in sim-out/final/*.json.
Suggested fresh seeds: 9101-9112 (one per config; never reuse).

Configs (one process at a time, <= 3 min each): {self, mixed, starters} x {Vickrey, FirstPrice} at 6p, plus heads-up (2p) Vickrey
and FirstPrice for final vs adversary/tuned/economist. Read paired d.score and d.win with SE from the report; flag any
cell where final trails the leader by more than 1 SE.
