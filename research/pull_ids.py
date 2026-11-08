"""Pull auction/topbid/word/participants for an explicit list of match ids (OR-queries, 5 per call).
usage: python3 pull_ids.py TAG id1,id2,...   (or TAG @file.json)"""
import json, sys, os
from q import q
tag = sys.argv[1]
ids = json.load(open(sys.argv[2][1:])) if sys.argv[2].startswith("@") else [int(x) for x in sys.argv[2].split(",")]
ids = sorted(set(ids))
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
fa = open(f"{D}/{tag}_auction.jsonl", "a"); ft = open(f"{D}/{tag}_topbid.jsonl", "a"); fw = open(f"{D}/{tag}_word.jsonl", "a"); fp = open(f"{D}/{tag}_mp.jsonl", "a")
for i in range(0, len(ids), 5):
    cond = " OR ".join(f"match_id = {m}" for m in ids[i:i+5])
    for r in q(f"SELECT * FROM auction_result WHERE {cond}"):
        w = r["winner_bot_id"]
        fa.write(json.dumps([r["auction_id"], r["match_id"], r["letter"], w[1] if w[0] == 0 else -1, r["paid"], r["closed_at"][0]]) + "\n")
    for r in q(f"SELECT * FROM auction_top_bid_archive WHERE {cond}"):
        ft.write(json.dumps([r["auction_id"], r["match_id"], r["top_bid"]]) + "\n")
    for r in q(f"SELECT * FROM word_play WHERE {cond}"):
        fw.write(json.dumps([r["id"], r["match_id"], r["bot_id"], r["word"], r["base_score"], r["bonus"], r["total_reward"], r["played_at"][0]]) + "\n")
    for r in q(f"SELECT * FROM match_participant WHERE {cond}"):
        fp.write(json.dumps([r["match_id"], r["bot_id"], r["balance"], r["score"]]) + "\n")
for f in (fa, ft, fw, fp): f.close()
