// nice -n 19 npx tsx src/strategies/tuned/diag.ts --players 6 --auction Vickrey --matches 300 --seed 5 [--params k=v,...] [--state PATH] [--field F]
import { existsSync, readFileSync } from "node:fs";
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
const matches = Number(arg("matches", "300"));
const seed = Number(arg("seed", "5"));
const rack = Number(arg("rack", "5"));
const field = arg("field", "field:topbot-like,topbot-like,topbot-like,mid-bot,mid-bot,hoarder,quick-cycler");
let p: TunedParams = { ...DEFAULT_PARAMS };
const sp = arg("state", "");
if (sp && existsSync(sp)) p = { ...p, ...JSON.parse(readFileSync(sp, "utf8")) };
const ps = arg("params", "");
if (ps) for (const kv of ps.split(",")) { const [k, v] = kv.split("="); (p as any)[k!] = Number(v); }
const reg = await loadRegistry();
reg.entries.set("tuned*", { name: "tuned*", factory: () => createStrategy(p), source: "strategies" });
const rep = runBatch({ tests: ["tuned*"], field, matches, seed, auctionType: auction, players, rack, maxSeconds: 100, showField: true, registry: reg });
for (const s of rep.strategies) {
  const a = s.perSeatAvg;
  console.log(`${(s.name + (s.vs ? "" : " [test]")).padEnd(20)} score ${s.score.mean.toFixed(1)}+-${s.score.se.toFixed(1)} swiss ${s.swiss.mean.toFixed(2)} win ${(s.win.mean * 100).toFixed(0)}% | words ${a.wordsPlayed.toFixed(2)} letters ${a.auctionsWon.toFixed(1)} spent ${a.spent.toFixed(0)} (${(a.spent / Math.max(1e-9, a.auctionsWon)).toFixed(1)}/ltr) tilesLeft ${a.tilesLeft.toFixed(1)} | bid ms ${s.timing.bidAvgMs.toFixed(3)}/${s.timing.bidMaxMs.toFixed(1)} words ms ${s.timing.wordsAvgMs.toFixed(3)}/${s.timing.wordsMaxMs.toFixed(1)} errs ${JSON.stringify(s.errors)}`);
}
