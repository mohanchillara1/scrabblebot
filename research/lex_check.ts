// Verifies src/models/_lex.ts against a brute-force scan of data/wordlist.txt, and times it.
import { readFileSync } from "node:fs";
import { lexicon, rewardOf, VALUES } from "../src/models/_lex.js";
const words = readFileSync(new URL("../data/wordlist.txt", import.meta.url), "utf8").split("\n").map((s) => s.trim().toUpperCase()).filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
const BAG = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const lex = lexicon();
function brute(rack: Int32Array, minLen: number) {
  let best = 0, bw = "";
  for (const w of words) {
    if (w.length < minLen) continue;
    const c = new Int32Array(26); let ok = true, base = 0;
    for (let i = 0; i < w.length; i++) { const k = w.charCodeAt(i) - 65; if (++c[k]! > rack[k]!) { ok = false; break; } base += VALUES[k]!; }
    if (!ok) continue;
    const r = rewardOf(base, w.length);
    if (r > best) { best = r; bw = w; }
  }
  return { best, bw };
}
let bad = 0, n = 0, tot = 0;
const t0 = performance.now();
const racks: Int32Array[] = [];
for (let t = 0; t < 150; t++) {
  const size = 5 + Math.floor(rnd() * 10);
  const rack = new Int32Array(26);
  for (let i = 0; i < size; i++) rack[BAG.charCodeAt(Math.floor(rnd() * BAG.length)) - 65]!++;
  racks.push(rack);
}
for (const rack of racks) for (const minLen of [2, 5, 7]) {
  const b = brute(rack, minLen);
  const p = lex.best(rack, minLen);
  n++;
  if ((p?.reward ?? 0) !== b.best) { bad++; if (bad < 5) console.log("MISMATCH", Array.from(rack).join(","), minLen, p, b); }
}
const t1 = performance.now();
for (let rep = 0; rep < 20; rep++) for (const rack of racks) { lex.best(rack, 2); tot++; }
const t2 = performance.now();
console.log(`checked ${n} (rack,minLen) pairs vs brute force: ${bad} mismatches; lex size ${lex.size} signatures`);
console.log(`best() avg ${(((t2 - t1) / tot) * 1000).toFixed(0)} us/call over ${tot} calls (rack sizes 5-14)`);
