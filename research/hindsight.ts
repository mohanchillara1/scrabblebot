// Diagnostic: for the sim opponent models, compare achieved score with the hindsight-optimal partition of every tile
// the seat ever held (dealt + bought). Tells whether the score gap to the real bots is word policy or tile acquisition.
import { setPriority } from "node:os";
import { runMatch, type EngineEvent, type Participant } from "../src/sim/engine.js";
import { PARAMS, makeOpponent, sampleField } from "../src/models/opponents.js";
import { bestPartition } from "../src/engine/words.js";
try { setPriority(0, 19); } catch { /* ignore */ }
const matches = Number(process.argv[2] ?? 150);
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(99);
const agg: Record<string, { ach: number[]; hind: number[]; held: number[] }> = {};
for (let m = 0; m < matches; m++) {
  const names = sampleField(6, rng, "botShare");
  const parts: Participant[] = names.map((n, i) => ({ kind: "real", name: n, strategy: makeOpponent(n, m * 10 + i) }));
  const held = names.map(() => new Uint8Array(26));
  const ev = (e: EngineEvent) => {
    if (e.type === "deal") for (const ch of e.letters) held[e.seat]![ch.charCodeAt(0) - 65]!++;
    else if (e.type === "close" && e.winnerSeat >= 0 && e.received && e.round < 68) held[e.winnerSeat]![e.letter.charCodeAt(0) - 65]!++;
  };
  const res = runMatch(parts, { auctionType: "Vickrey", seed: 5, matchIndex: m, onEvent: ev });
  res.seats.forEach((s, i) => {
    const a = (agg[names[i]!] ??= { ach: [], hind: [], held: [] });
    const total = held[i]!.reduce((x, y) => x + y, 0);
    const r = bestPartition(held[i]!, { timeBudgetMs: 30 } as never);
    a.ach.push(s.score); a.hind.push(r.total); a.held.push(total);
  });
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
for (const [k, a] of Object.entries(agg)) console.log(`${k.padEnd(14)} achieved ${mean(a.ach).toFixed(1)}  hindsight-optimal ${mean(a.hind).toFixed(1)}  tiles ever held ${mean(a.held).toFixed(1)}  ratio ${(mean(a.ach) / mean(a.hind)).toFixed(2)}`);
