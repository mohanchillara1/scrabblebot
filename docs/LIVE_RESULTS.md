# Live practice results (real server, real bots) — ground truth

Generated from ~/scrabblebot-work/logs/*.log by ~/scrabblebot-work/live_summary.py. Lobby matches vs whoever was queued (mostly real bots). Matches the process joined already in progress (start < 2 s after connect) are excluded.

| strategy | matches | mean score (SE) | mean place (SE) | wins | mean Swiss pts (n-place) | mean winner score |
|---|---|---|---|---|---|---|
| tuned | 13 | 70.2 (4.3) | 4.00 (0.34) | 1 | 2.00 | 102.6 |
| economist | 13 | 84.2 (4.8) | 2.77 (0.39) | 2 | 3.23 | 110.2 |
| mcvalue | 10 | 71.3 (2.9) | 3.50 (0.40) | 0 | 2.50 | 111.2 |
