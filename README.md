# Lexiconda — a ScrabbleBot tournament bot

Bot for the SpacetimeDB [ScrabbleBot](https://scrabblebot.spacetimedb.com/) tournament at HackUTD 2026.
Bots win letters in 1-second sealed-bid auctions and spend them on dictionary words; 7+ letter words pay 3×.

Built on the Clockwork Labs starter kit (MIT, see `LICENSE.upstream-MIT`).

## How it plays

`src/strategies/final.ts` picks a strategy per match from the table size:

- **3+ players (Swiss rounds, bracket): `economist`.** It values each auctioned letter by Monte-Carlo estimates of how
  much it adds to the best final set of words, converts that to a bid using the money left and auctions remaining, bids
  truthfully under Vickrey and shades under first-price, and spends down late-game cash, since unspent balance scores nothing.
- **Heads-up (the final): an adaptive going-rate bidder.** It learns the clearing price during the match and buys most of the
  tiles cheaply, cycling 7-letter words.
- **Endgame:** the whole rack is played as the best set of disjoint words one auction before the bag empties.

## Layout

| path | what |
|---|---|
| `src/engine/words.ts` | word engine: playable words, best word, best disjoint-word partition (branch and bound) |
| `src/strategies/` | candidate strategies (`economist`, `tuned`, `mcvalue`, `adversary`) and the `final` dispatcher |
| `src/sim/` | offline simulator of the server's match rules, plus the tournament harness |
| `src/models/` | opponent models fitted to public match history |
| `src/live/` | live client: builds the match view from SpacetimeDB tables, sends words then bids, reconnects, stall watchdog |
| `research/` | scripts that pull and analyse the public match data |
| `docs/` | game spec, simulator tournament results, live practice results, run instructions |

## Run

```sh
npm install
BOT_NAME=<name> BOT_TOKEN=<token from the team page> STRATEGY=final npm run bot   # first run
BOT_NAME=<name> STRATEGY=final TOURNAMENT_ID=<id> LOBBY=0 npm run bot              # tournament
npm run sim -- --test final --field mixed --matches 200 --players 6                # offline simulation
```

See `docs/RUNNING.md` for details.
