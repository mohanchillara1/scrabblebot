// Coordinate-descent tuner for the "tuned" strategy (paired duplicate matches vs the current best).
//   nice -n 19 timeout 200 npx tsx src/strategies/tuned/tune.ts --players 6 --auction Vickrey --matches 400 --seed 101 --budget 160 [--state PATH] [--params k=v,k=v]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import type { AuctionType } from "../../core/types.js";
import { runBatch } from "../../sim/harness.js";
import { loadRegistry } from "../../sim/registry.js";
import { createStrategy, DEFAULT_PARAMS, type TunedParams } from "../tuned.js";

try { setPriority(0, 19); } catch { /* ignore */ }
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const players = Number(arg("players", "6"));
const auction = arg("auction", "Vickrey") as AuctionType;
const matches = Number(arg("matches", "400"));
const seed = Number(arg("seed", "101"));
const budget = Number(arg("budget", "160"));
const rack = Number(arg("rack", "5"));
const statePath = arg("state", `docs/notes/tuned_best_${players}p_${auction}.json`);
const field = arg("field", "field:topbot-like,topbot-like,topbot-like,mid-bot,mid-bot,hoarder,quick-cycler");
const only = arg("only", "");

let best: TunedParams = { ...DEFAULT_PARAMS };
if (existsSync(statePath)) best = { ...best, ...JSON.parse(readFileSync(statePath, "utf8")) };
const init = arg("params", "");
if (init) for (const kv of init.split(",")) { const [k, v] = kv.split("="); (best as any)[k!] = Number(v); }

const steps: [keyof TunedParams, number][] = [
  ["vickMult", 0.15], ["paceK", 0.4], ["paceEnd", 0.15], ["valK", 0.15], ["synK", 0.4], ["deadK", 0.15], ["dupC", 0.06],
  ["balK", 0.06], ["endK", 3], ["endMult", 0.3], ["capFrac", 0.2], ["dumpK", 2], ["fadeK", 0.015], ["leaveTile", 1],
  ["floorBid", 1], ["liqBal", 8], ["fpMult", 0.1], ["fpPrior", 0.15], ["syn2K", 0.2], ["emaAlpha", 0.06], ["playMinLen", 1],
];

const reg = await loadRegistry();
const t0 = performance.now();
let n = 0;
function evalPair(a: TunedParams, b: TunedParams) {
  const na = `tA${n}`, nb = `tB${n++}`;
  reg.entries.set(na, { name: na, factory: () => createStrategy(a), source: "strategies" });
  reg.entries.set(nb, { name: nb, factory: () => createStrategy(b), source: "strategies" });
  const rep = runBatch({ tests: [na, nb], field, matches, seed, auctionType: auction, players, rack, maxSeconds: 60, showField: false, registry: reg });
  const A = rep.strategies.find((s) => s.name === na)!;
  const pr = rep.paired[0]!;
  return { rep, base: A, dScore: pr.dScore, dSwiss: pr.dSwiss };
}
const el = () => (performance.now() - t0) / 1000;
console.log(`tune: players=${players} ${auction} matches=${matches} seed=${seed} state=${statePath}`);
for (const [key, delta] of steps) {
  if (only && !only.split(",").includes(key)) continue;
  for (const dir of [1, -1]) {
    if (el() > budget) break;
    const cand = { ...best } as any;
    cand[key] = Math.max(0, cand[key] + dir * delta);
    if (key === "endK" || key === "dumpK" || key === "playMinLen" || key === "floorBid") cand[key] = Math.round(cand[key]);
    if (key === "playMinLen") cand[key] = Math.min(10, Math.max(4, cand[key]));
    if (cand[key] === (best as any)[key]) continue;
    const r = evalPair(best, cand);
    const zs = r.dScore.mean / (r.dScore.se || 1);
    const acc = zs > 1.5 && r.dSwiss.mean > -r.dSwiss.se;
    console.log(`${String(key).padEnd(10)} ${(best as any)[key]} -> ${cand[key]}  dScore ${r.dScore.mean.toFixed(2)}+-${r.dScore.se.toFixed(2)} dSwiss ${r.dSwiss.mean.toFixed(3)}+-${r.dSwiss.se.toFixed(3)} base=${r.base.score.mean.toFixed(1)} ${acc ? "ACCEPT" : ""} [${el().toFixed(0)}s]`);
    if (acc) { best = cand; writeFileSync(statePath, JSON.stringify(best, null, 1)); break; }
  }
}
writeFileSync(statePath, JSON.stringify(best, null, 1));
console.log("best:", JSON.stringify(best));
