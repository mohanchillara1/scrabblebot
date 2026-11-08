"""Tiny read-only SQL helper for the public scrabblebot DB. Usage: from q import q; rows = q("SELECT ...")"""
import json, os, subprocess, sys
D = os.path.dirname(os.path.abspath(__file__))
def _tok():
    p = os.path.join(D, ".token-anon")
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        out = subprocess.check_output(["curl","-s","-X","POST","https://maincloud.spacetimedb.com/v1/identity"])
        open(p,"w").write(json.loads(out)["token"])
    return open(p).read().strip()
def _unwrap(v):
    # SpacetimeDB sum encoding: Option some = [0, x], none = [1, []]
    return v
def q(sql, raw=False):
    out = subprocess.check_output(["curl","-s","-X","POST","https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql",
        "-H","Authorization: Bearer "+_tok(),"--data",sql])
    try:
        j = json.loads(out)
    except Exception:
        raise RuntimeError(out.decode()[:500])
    res = j[0]
    cols = [e["name"]["some"] for e in res["schema"]["elements"]]
    rows = res["rows"]
    if raw: return cols, rows
    return [dict(zip(cols, r)) for r in rows]
if __name__ == "__main__":
    print(json.dumps(q(sys.argv[1])[:int(sys.argv[2]) if len(sys.argv)>2 else 20], indent=None))
