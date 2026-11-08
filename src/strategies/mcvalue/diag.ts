// Diagnostic runner: mean per-seat stats (score, wins, spend, words, tiles left, final balance) for named strategies.
// usage: nice -n 19 npx tsx src/strategies/mcvalue/diag.ts <test> <opp1,opp2,...> [matches] [players] [Vickrey|FirstPrice] [rack]
import { loadRegistry, instantiate } from "../../sim/registry.js";
import { runMatch, type Participant } from "../../sim/engine.js";

const [test = "mcvalue", oppArg = "topbot-like", mArg = "100", pArg = "6", aArg = "Vickrey", rArg = "5"] = process.argv.slice(2);
const matches = Number(mArg), players = Number(pArg), rack = Number(rArg);
const reg = await loadRegistry();
const opps = oppArg.split(",");
const stat = (xs: number[]) => {
  const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1);
  return `${m.toFixed(1)}±${Math.sqrt(v / n).toFixed(1)}`;
};
const acc: Record<string, number[]> = { score: [], won: [], spent: [], words: [], left: [], bal: [], place: [] };
const oacc: Record<string, number[]> = { score: [], won: [], spent: [], words: [], left: [], bal: [], place: [] };
const t0 = Date.now();
for (let m = 0; m < matches; m++) {
  if (Date.now() - t0 > 170000) break;
  const seat = m % players;
  const parts: Participant[] = [];
  for (let s = 0; s < players; s++) {
    if (s === seat) parts.push({ kind: "real", name: test, strategy: instantiate(reg.entries.get(test)!, m * 31 + s) });
    else {
      const on = opps[(s < seat ? s : s - 1) % opps.length]!;
      parts.push({ kind: "real", name: on, strategy: instantiate(reg.entries.get(on)!, m * 31 + s) });
    }
  }
  const r = runMatch(parts, { auctionType: aArg as any, startingRackSize: rack, seed: 7, matchIndex: m, matchId: 1000 + m });
  for (const x of r.seats) {
    const a = x.seat === seat ? acc : oacc;
    a.score!.push(x.score); a.won!.push(x.auctionsWon); a.spent!.push(x.spent); a.words!.push(x.wordsPlayed);
    a.left!.push(x.tilesLeft); a.bal!.push(x.balance); a.place!.push(x.place);
  }
}
const line = (nm: string, a: Record<string, number[]>) =>
  console.log(nm.padEnd(14), "n=" + a.score!.length, "score", stat(a.score!), "won", stat(a.won!), "spent", stat(a.spent!),
    "$/tile", (a.spent!.reduce((x, y) => x + y, 0) / Math.max(1, a.won!.reduce((x, y) => x + y, 0))).toFixed(1),
    "words", stat(a.words!), "left", stat(a.left!), "bal", stat(a.bal!), "place", stat(a.place!));
line(test, acc);
line("opps(avg)", oacc);
