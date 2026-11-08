"""Fit the per-model bidder `level` so that simulated letters-per-seat match the observed cluster means.
Proportional update: level *= (target/sim)^0.6. Prints the final --set string."""
import subprocess, re, sys, json
T = json.load(open("research/derived/targets.json"))
models = ["topbot-like", "mid-bot", "hoarder", "quick-cycler", "weak-passive"]
levels = {"topbot-like": 1.05, "mid-bot": 1.0, "hoarder": 0.95, "quick-cycler": 0.95, "weak-passive": 1.0}
fixed = sys.argv[1] if len(sys.argv) > 1 else ""
for it in range(6):
    s = ",".join([fixed] if fixed else []) 
    s = ",".join(x for x in [fixed] + [f"{m}.level={levels[m]:.4f}" for m in models] if x)
    out = subprocess.run(["nice","-n","19","npx","tsx","research/calibrate.ts","--matches","800","--seed",str(30+it),"--set",s], capture_output=True, text=True).stdout
    sim = {}
    for line in out.splitlines():
        p = line.split()
        if p and p[0] in models and len(p) > 3: sim[p[0]] = (float(p[1]), float(p[2]))
    print(it, {m:(levels[m], sim[m]) for m in models}, flush=True)
    for m in models:
        tgt = T[m]["letters_won"]
        levels[m] *= (tgt / sim[m][1]) ** 0.6
print("FINAL", ",".join(f"{m}.level={levels[m]:.3f}" for m in models))
