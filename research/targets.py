import sys, json
sys.path.insert(0,'/home/mohan/scrabblebot-work/bot/research')
from analyze2 import *
CL = {
 "topbot-like":   [171,114,193,207,18],
 "mid-bot":       [181,180,179,190,192,172,168,178,186,209,195],
 "hoarder":       [201,191,212,167,200],
 "quick-cycler":  [164,166,188,182,183,162,169,165,199,202,170,161],
 "weak-passive":  [185,194,204,173,206,205,196,174,145,184,187,175],
}
tot_slots = sum(len(feat[b]) for b in feat)
out = {}
allw = defaultdict(list)
for cl, ids in CL.items():
    seats = [(b,x) for b in ids for x in feat[b]]
    n = len(seats)
    sc = np.array([x["score"] for _,x in seats], float)
    won = np.array([len([w for w in x["won"] if w[0]<68]) for _,x in seats], float)
    paid = np.array([sum(w[2] for w in x["won"]) for _,x in seats], float)
    bal = np.array([x["bal"] for _,x in seats], float)
    nw = np.array([len(x["words"]) for _,x in seats], float)
    lens = [len(w[1]) for _,x in seats for w in x["words"]]
    rounds = [w[0] for _,x in seats for w in x["words"]]
    main = [w for _,x in seats for w in x["words"] if w[0] <= 64]
    # per-seat main-plays (<=r64)
    nmain = np.array([len([w for w in x["words"] if w[0] <= 64]) for _,x in seats], float)
    dump = np.array([len([w for w in x["words"] if w[0] >= 65]) for _,x in seats], float)
    first7 = []
    for _,x in seats:
        ws = sorted(x["words"])
        s7 = [w[0] for w in ws if len(w[1])>=7]
        if s7: first7.append(s7[0])
    v1 = [w[3] for _,x in seats for w in x["won"] if w[0]<68 and val[w[1]]==1]
    v1p = [w[2] for _,x in seats for w in x["won"] if w[0]<68 and val[w[1]]==1]
    out[cl] = dict(bots=ids, seat_matches=n, share=n/tot_slots,
        score=sc.mean(), score_se=sc.std()/n**.5, score_sd=sc.std(),
        letters_won=won.mean(), px=paid.sum()/won.sum(), spent=paid.mean(), bal_end=bal.mean(),
        words=nw.mean(), main_plays=nmain.mean(), dump_plays=dump.mean(),
        avg_len=float(np.mean(lens)), len7plus=float(np.mean([l>=7 for l in lens])),
        play_round_median=float(np.median(rounds)), play_frac_after_r34=float(np.mean([r>34 for r in rounds])), play_frac_r58plus=float(np.mean([r>=58 for r in rounds])),
        first7_round_median=float(np.median(first7)) if first7 else None,
        v1_winbid=float(np.mean(v1)), v1_paid=float(np.mean(v1p)),
        tile_value_won=float(np.mean([val[w[1]] for _,x in seats for w in x["won"] if w[0]<68])),
        rew7=float(np.mean([w[2] for _,x in seats for w in x['words'] if len(w[1])==7])),
        hi_share=float(np.mean([1 if val[w[1]]>=4 else 0 for _,x in seats for w in x['won'] if w[0]<68])),
        tiles_played=float(sum(len(w[1]) for _,x in seats for w in x["words"])/n),
        reward_per_tile=float(sum(w[2] for _,x in seats for w in x["words"])/max(1,sum(len(w[1]) for _,x in seats for w in x["words"]))))
json.dump(out, open("data/targets.json","w"), indent=1)
print(f"{'cluster':14s} {'seats':>6s} {'share':>6s} {'score':>12s} {'sd':>5s} {'letters':>7s} {'px':>5s} {'spent':>6s} {'bal_end':>7s} {'words':>5s} {'main':>5s} {'dump':>5s} {'len':>4s} {'7+':>4s} {'medr':>5s} {'>34':>4s} {'>=58':>5s} {'f7r':>5s} {'v1win':>5s} {'v1pd':>5s}")
for cl,o in out.items():
    print(f"{cl:14s} {o['seat_matches']:6d} {o['share']:6.3f} {o['score']:6.1f}+-{o['score_se']:4.1f} {o['score_sd']:5.1f} {o['letters_won']:7.2f} {o['px']:5.2f} {o['spent']:6.1f} {o['bal_end']:7.1f} {o['words']:5.2f} {o['main_plays']:5.2f} {o['dump_plays']:5.2f} {o['avg_len']:4.2f} {o['len7plus']:4.2f} {o['play_round_median']:5.1f} {o['play_frac_after_r34']:4.2f} {o['play_frac_r58plus']:5.2f} {o['first7_round_median'] or 0:5.1f} {o['v1_winbid']:5.2f} {o['v1_paid']:5.2f}")
