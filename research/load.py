import json, os, datetime
from collections import defaultdict, Counter
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CT = datetime.timezone(datetime.timedelta(hours=-6))
def ct(us): return datetime.datetime.fromtimestamp(us/1e6, datetime.timezone.utc).astimezone(CT)
bots = {b["id"]: b for b in json.load(open(f"{D}/bot.json"))}
stats = {s["bot_id"]: s for s in json.load(open(f"{D}/bot_stats.json"))}
ms = {m["id"]: m for m in json.load(open(f"{D}/match_state.json"))}
def name(b): return bots[b]["name"] if bots[b]["name"] else f"#{b}"
def is_sim(b): return bots[b]["is_simulated"]
def jl(path):
    with open(path) as f:
        for line in f: yield json.loads(line)
def load_mp(path=f"{D}/mp_recent.json"):
    by = defaultdict(list)
    for mid, bid, bal, sc in json.load(open(path)): by[mid].append((bid, bal, sc))
    return by
def load_tag(tag):
    """returns auctions[match] = list of (auction_id, letter, winner(-1 none), paid, closed_at, top_bid) sorted by auction_id; words[match]=list"""
    top = {a: t for a, m, t in jl(f"{D}/{tag}_topbid.jsonl")}
    auc = defaultdict(list)
    for aid, mid, let, w, paid, c in jl(f"{D}/{tag}_auction.jsonl"):
        auc[mid].append((aid, let, w, paid, c, top.get(aid)))
    for m in auc: auc[m].sort()
    words = defaultdict(list)
    for wid, mid, bid, word, base, bonus, rew, at in jl(f"{D}/{tag}_word.jsonl"):
        words[mid].append((wid, bid, word, base, bonus, rew, at))
    for m in words: words[m].sort()
    return auc, words
