// CLI for the ScrabbleBot simulator.
//
//   nice -n 19 npx tsx src/sim/run.ts --test a,b --field lobby-sims --matches 300 --seed 1 --auction Vickrey
//
// Options
//   --test a,b,...      strategies to evaluate (registry names; `--list` shows them)          [required]
//   --field F           lobby-sims | starters | mixed | self | field:<comma list>             [lobby-sims]
//                         lobby-sims  each test strategy alone vs 5 of the 6 server sim bots
//                         starters    vs 5 official-starter bots
//                         mixed       vs a random mix of sims, starter, starter-hold7, value-plus, src/models/*
//                         field:a,b   explicit opponents (sim names such as Cheapo-sim, sim tags Cheapskate/
//                                     ValueBidder/Aggressive, or registry names). Fewer than players-1 names repeat
//                                     in order; more are sampled per match.
//                         self        the test strategies play each other, seats rotated
//   --matches N         duplicate matches per test strategy                                    [200]
//   --seed S            integer seed; same seed => same bags / sims / opponents / seats         [1]
//   --auction A         Vickrey | FirstPrice | both                                            [Vickrey]
//   --players N         seats per match                                                        [6]
//   --rack N            starting rack size                                                     [5]
//   --max-seconds T     stop starting new matches after T seconds (3-minute rule)               [170]
//   --show-field        also print the opponents' own statistics
//   --out PATH          JSON output path                                         [sim-out/<auto>.json]
//   --no-json           do not write JSON
//   --list              list available strategies and exit
//   --quiet             no progress line

import { mkdirSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import { dirname, resolve } from "node:path";
import type { AuctionType } from "../core/types.js";
import { type BatchReport, formatReport, runBatch } from "./harness.js";
import { loadRegistry } from "./registry.js";

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(key, true);
    else {
      out.set(key, next);
      i++;
    }
  }
  return out;
}

function int(args: Map<string, string | true>, key: string, dflt: number): number {
  const v = args.get(key);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`--${key} must be an integer, got "${String(v)}"`);
  return n;
}

async function main(): Promise<void> {
  // Same effect as `nice -n 19` (laptop compute rule); harmless if it fails.
  try {
    setPriority(0, 19);
  } catch {
    /* ignore */
  }

  const args = parseArgs(process.argv.slice(2));
  const registry = await loadRegistry();
  for (const e of registry.loadErrors) console.error(`[registry] skipped ${e.file}: ${e.error}`);

  if (args.has("list")) {
    for (const e of registry.entries.values()) console.log(`${e.name.padEnd(28)} ${e.source}${e.file ? "  " + e.file : ""}`);
    return;
  }

  const testArg = args.get("test");
  if (typeof testArg !== "string") throw new Error("--test is required (comma-separated strategy names; --list shows them)");
  const tests = testArg.split(",").map((s) => s.trim()).filter(Boolean);
  const field = typeof args.get("field") === "string" ? (args.get("field") as string) : "lobby-sims";
  const matches = int(args, "matches", 200);
  const seed = int(args, "seed", 1);
  const players = int(args, "players", 6);
  const rack = int(args, "rack", 5);
  const maxSeconds = Number(args.get("max-seconds") ?? 170);
  const aucArg = typeof args.get("auction") === "string" ? (args.get("auction") as string) : "Vickrey";
  const types: AuctionType[] =
    aucArg.toLowerCase() === "both" ? ["Vickrey", "FirstPrice"]
    : aucArg.toLowerCase() === "vickrey" ? ["Vickrey"]
    : aucArg.toLowerCase() === "firstprice" ? ["FirstPrice"]
    : (() => { throw new Error(`--auction must be Vickrey, FirstPrice or both, got "${aucArg}"`); })();
  const quiet = args.has("quiet");
  const showField = args.has("show-field");

  const reports: BatchReport[] = [];
  // With both auction types the time budget is split so the whole command stays inside the limit.
  const perTypeSeconds = maxSeconds / types.length;
  for (const auctionType of types) {
    let lastPrint = 0;
    const report = runBatch({
      tests, field, matches, seed, auctionType, players, rack, maxSeconds: perTypeSeconds, showField, registry,
      onProgress: quiet
        ? undefined
        : (done, total, el) => {
            if (el - lastPrint >= 5 || done === total) {
              lastPrint = el;
              process.stderr.write(`\r[${auctionType}] ${done}/${total} matches, ${el.toFixed(0)}s   `);
            }
          },
    });
    if (!quiet) process.stderr.write("\n");
    console.log(formatReport(report));
    console.log("");
    reports.push(report);
  }

  if (!args.has("no-json")) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._,-]+/g, "_");
    const dflt = `sim-out/${stamp}_${safe(field)}_${safe(tests.join("+"))}_s${seed}_n${matches}.json`;
    const out = resolve(typeof args.get("out") === "string" ? (args.get("out") as string) : dflt);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, reports, registryLoadErrors: registry.loadErrors }, null, 2),
    );
    console.log(`JSON written to ${out}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
