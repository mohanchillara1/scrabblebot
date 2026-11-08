import sys; sys.path.insert(0,'.')
from load import *
import statistics as st, bisect, numpy as np
mp = load_mp()
auc, words = load_tag("recent")
M6 = [mid for mid, ps in mp.items() if ms[mid]["st"]==2 and len(auc.get(mid,[]))==68 and sum(1 for b,_,_ in ps if not is_sim(b))==6]
print("M6 matches", len(M6), "ids", min(M6), max(M6), ct(ms[min(M6)]["c"]).strftime("%m-%d %H:%M"), ct(ms[max(M6)]["c"]).strftime("%m-%d %H:%M"))
# per-bot per-match features
feat = defaultdict(list)
for mid in M6:
    A = auc[mid]; closes = [a[4] for a in A]
    res = {b:(bal,sc) for b,bal,sc in mp[mid]}
    won = defaultdict(list)   # bot -> list of (round, letter, paid, top)
    for r,(aid,let,w,paid,c,top) in enumerate(A, start=1):
        if w >= 0: won[w].append((r,let,paid,top))
    W = defaultdict(list)
    for wid,bid,word,base,bonus,rew,at in words.get(mid,[]):
        rnd = bisect.bisect_right(closes, at)   # number of auctions closed by then (0..68)
        W[bid].append((rnd, word, rew))
    for b,(bal,sc) in res.items():
        feat[b].append(dict(mid=mid, score=sc, bal=bal, won=won.get(b,[]), words=W.get(b,[])))
json_out = {}
def summarize(b):
    L = feat[b]; n = len(L)
    nw = [len(x["won"]) for x in L]
    paid = [sum(w[2] for w in x["won"]) for x in L]
    nwords = [len(x["words"]) for x in L]
    lens = Counter(len(w[1]) for x in L for w in x["words"])
    totw = sum(lens.values())
    rew = sum(w[2] for x in L for w in x["words"])
    rounds = [w[0] for x in L for w in x["words"]]
    return dict(n=n, letters_won=st.mean(nw), paid=st.mean(paid), price=(sum(paid)/max(1,sum(nw))), nwords=st.mean(nwords),
                avglen=sum(k*v for k,v in lens.items())/max(1,totw), lens={k:round(v/totw,3) for k,v in sorted(lens.items())},
                med_round=float(np.median(rounds)) if rounds else None, frac_after_half=(sum(1 for r in rounds if r>34)/max(1,len(rounds))),
                frac_last10=(sum(1 for r in rounds if r>=58)/max(1,len(rounds))),
                score=st.mean(x["score"] for x in L), bal=st.mean(x["bal"] for x in L))
if __name__ == "__main__":
    order = sorted([b for b in feat if len(feat[b])>=15], key=lambda b:-st.mean(x["score"] for x in feat[b]))
    print("bot name n | letters_won paid price/letter | nwords avglen | med_round %play>half %play>=r58 | score bal")
    for b in order:
        s = summarize(b)
        print(f"{b:4d} {name(b)[:18]:18s} n={s['n']:4d} | won {s['letters_won']:5.1f} paid {s['paid']:6.1f} px {s['price']:5.2f} | words {s['nwords']:4.1f} len {s['avglen']:4.2f} | medr {s['med_round']} late {s['frac_after_half']:.2f} end {s['frac_last10']:.2f} | sc {s['score']:6.1f} bal {s['bal']:5.1f}")
