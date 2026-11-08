#!/bin/bash
# usage: sql.sh "<SQL>"   -> prints raw JSON result. Token cached in research/.token
D="$(cd "$(dirname "$0")" && pwd)"
if [ ! -s "$D/.token-anon" ]; then
  curl -s -X POST https://maincloud.spacetimedb.com/v1/identity | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' > "$D/.token-anon"
fi
curl -s -X POST https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql -H "Authorization: Bearer $(cat "$D/.token-anon")" --data "$1"
