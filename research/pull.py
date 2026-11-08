"""Pull auction_result / auction_top_bid_archive / word_play for a match-id range in 50-match chunks, append to compact JSONL.
usage: python3 pull.py LO HI TAG   (match ids LO < id <= HI)"""
import json, sys, os
from q import q
lo, hi, tag = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
fa = open(f"{D}/{tag}_auction.jsonl", "a"); ft = open(f"{D}/{tag}_topbid.jsonl", "a"); fw = open(f"{D}/{tag}_word.jsonl", "a")
step = 50
while lo < hi:
    h = min(lo + step, hi)
    for r in q(f"SELECT * FROM auction_result WHERE match_id > {lo} AND match_id <= {h}"):
        w = r["winner_bot_id"]
        fa.write(json.dumps([r["auction_id"], r["match_id"], r["letter"], w[1] if w[0] == 0 else -1, r["paid"], r["closed_at"][0]]) + "\n")
    for r in q(f"SELECT * FROM auction_top_bid_archive WHERE match_id > {lo} AND match_id <= {h}"):
        ft.write(json.dumps([r["auction_id"], r["match_id"], r["top_bid"]]) + "\n")
    for r in q(f"SELECT * FROM word_play WHERE match_id > {lo} AND match_id <= {h}"):
        fw.write(json.dumps([r["id"], r["match_id"], r["bot_id"], r["word"], r["base_score"], r["bonus"], r["total_reward"], r["played_at"][0]]) + "\n")
    lo = h
fa.close(); ft.close(); fw.close()
