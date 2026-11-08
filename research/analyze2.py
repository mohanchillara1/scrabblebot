import sys; sys.path.insert(0,'/home/mohan/scrabblebot-work/bot/research')
from analyze1 import *
val = {c:1 for c in "AEIOULNSTR"}; val.update({c:2 for c in "DG"}); val.update({c:3 for c in "BCMP"}); val.update({c:4 for c in "FHVWY"}); val.update({"K":5,"J":8,"X":8,"Q":10,"Z":10})
def cls(l): return val[l]
# balance timeline per bot per match: balance just before auction r closes
def timeline(mid, bid):
    A = auc[mid]; W = [w for w in words.get(mid, []) if w[1]==bid]
    bal = 100; out = []; wi = 0
    for r,(aid,let,w,paid,c,top) in enumerate(A, start=1):
        while wi < len(W) and W[wi][6] <= c: bal += W[wi][5]; wi += 1
        out.append(bal)
        if w == bid: bal -= paid
    return out
if __name__ == "__main__":
    TOP = [171,114,193,207,18,181,180,179,191]
    # win rate by value class, share of letters
    avail = Counter(); wonc = defaultdict(Counter)
    for mid in M6:
        for r,(aid,let,w,paid,c,top) in enumerate(auc[mid], start=1):
            if r==68: continue
            avail[cls(let)] += 1
    for b in TOP:
        for x in feat[b]:
            for (r,let,paid,top) in x["won"]:
                if r<68: wonc[b][cls(let)] += 1
    print("win-rate by value class (fraction of that class's auctions won; baseline = 1/6=0.167)")
    for b in TOP:
        n = len(feat[b])
        print(f"{b:4d} {name(b)[:16]:16s} " + " ".join(f"v{k}:{wonc[b][k]/(avail[k]/len(M6)*n):.3f}" for k in sorted(avail)))
    # winning bid / balance and balance curve
    print("\nbalance curve (mean balance before auction r closes) and winning-bid/balance, top5 pooled")
    curve = defaultdict(list); ratio=defaultdict(list); ratio_paid=defaultdict(list)
    for b in TOP[:5]:
        for x in feat[b]:
            tl = timeline(x["mid"], b)
            for r,bal in enumerate(tl, start=1): curve[(r-1)//8].append(bal)
            for (r,let,paid,top) in x["won"]:
                if r<68 and tl[r-1]>0:
                    ratio[(r-1)//8].append(top/tl[r-1]); ratio_paid[(r-1)//8].append(paid/tl[r-1])
    for k in sorted(curve): print(f"rounds {k*8+1:2d}-{k*8+8:2d}: mean balance {np.mean(curve[k]):6.1f}  win-bid/bal {np.mean(ratio[k]) if ratio[k] else 0:.2f}  paid/bal {np.mean(ratio_paid[k]) if ratio_paid[k] else 0:.2f}")
    # word timing histogram for top bots (by 8-round bins), and reward by timing
    print("\nword plays per match by round-bin (top5 pooled) and mean length/reward")
    cnt=defaultdict(int); L=defaultdict(list); R=defaultdict(list); nm_=0
    for b in TOP[:5]:
        for x in feat[b]:
            nm_+=1
            for (rnd,word,rew) in x["words"]:
                k=(max(rnd,1)-1)//8; cnt[k]+=1; L[k].append(len(word)); R[k].append(rew)
    for k in sorted(cnt): print(f"rounds {k*8+1:2d}-{k*8+8:2d}: words/match {cnt[k]/nm_:.2f}  mean len {np.mean(L[k]):.2f} mean reward {np.mean(R[k]):.1f}")
    # rack usage: rewards by length
    byl=defaultdict(list)
    for b in TOP[:5]:
        for x in feat[b]:
            for (rnd,word,rew) in x["words"]: byl[len(word)].append(rew)
    print("word len -> share, mean reward:", {k:(len(v),round(np.mean(v),1)) for k,v in sorted(byl.items())})
