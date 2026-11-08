# Live practice results (real server, real bots) — ground truth

Generated from ~/scrabblebot-work/logs/*.log by ~/scrabblebot-work/live_summary.py. Lobby matches vs whoever was queued (mostly real bots). Matches the process joined already in progress (start < 2 s after connect) are excluded.

| strategy | matches | mean score (SE) | mean place (SE) | wins | mean Swiss pts (n-place) | mean winner score |
|---|---|---|---|---|---|---|
| tuned | 22 | 75.5 (3.3) | 3.18 (0.31) | 4 | 2.82 | 106.2 |
| economist | 23 | 80.0 (3.9) | 3.13 (0.30) | 3 | 2.87 | 110.4 |
| mcvalue | 15 | 71.5 (2.8) | 3.33 (0.35) | 1 | 2.67 | 106.9 |
