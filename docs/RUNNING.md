# Running the live bot

All commands run from `/home/mohan/scrabblebot-work/bot`. One bot credential per process:
**never run two processes on the same token** (same identity; the server holds one session per identity,
and both processes would also bid on the same auctions).

## 1. Set the token (first run only)

The bot saves its token to `.token-<BOT_NAME>` in the current directory (git-ignored). A token file already
exists for `Lexiconda`, so later runs need only `BOT_NAME=Lexiconda`.

First run for a new bot name, with a token from the website team page ("Generate token"):

```
BOT_NAME=Lexiconda BOT_TOKEN='<token>' npm run bot
```

or with a nonce from the CLI (`spacetime call scrabblebot mint_credential_nonce`, then
`spacetime sql scrabblebot 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`):

```
BOT_NAME=Lexiconda BOT_NONCE='<code>' npm run bot
```

To rotate, mint a new token on the team page and pass it as `BOT_TOKEN` once.

## 2. Run in the lobby (testing)

```
BOT_NAME=Lexiconda STRATEGY=final npm run bot
```

The bot joins the lobby on connect (after a 1.5 s settle), and again after every match. Lobby matches pad
with sim bots after 90 s, so a match starts within about 90 s. Stop with Ctrl-C (prints final stats).

Healthy startup log:

```
[Lexiconda] strategy: final -> <strategy name>
HH:MM:SS.mmm [Lexiconda] word engine warm (350 ms)
HH:MM:SS.mmm [Lexiconda] connected as <identity hex>
HH:MM:SS.mmm [Lexiconda] acting as bot 'Lexiconda' (id N)
HH:MM:SS.mmm [Lexiconda] joined lobby (startup)
```

If you see a block of `!!!!` lines the requested strategy failed to import and the **starter baseline is
playing instead**. Fix the strategy file (or the `STRATEGY` name) and restart.

One line per auction, written when the result arrives:

```
[Lexiconda] m45360 r17 'E' bid=12 WON paid 9 | bal=71 score=33 words=QUIZ bidMs=41 opt-ok
```

`m` is the match id, `r` the round, `bid` the amount that is live at the server when the auction closes,
`bidMs` the time from the auction insert reaching this process to the first `submitBid` call (includes
`strategy.words()` and `strategy.bid()` compute), `opt-ok` / `opt-rejected` records the optimistic bid raise
(see "How a bid is sent" below). `LATE` means the server answered "Auction window expired".
A STATS line every 120 s and on Ctrl-C summarises calls, errors and the insert-to-bid latency.

## 3. Register for a tournament

Find the tournament id (read-only public SQL; the id is also on the tournament page):

```
TOKEN=$(curl -s -X POST https://maincloud.spacetimedb.com/v1/identity | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -X POST https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql -H "Authorization: Bearer $TOKEN" --data 'SELECT * FROM tournament'
```

Then run the bot with the id. It calls `register_for_tournament` once on connect, on every (re)connect:

```
BOT_NAME=Lexiconda STRATEGY=final TOURNAMENT_ID=<id> npm run bot
```

Leave it running and connected: a registered bot that is offline is still seated and loses every auction.
The admin cannot start the tournament while a registered bot is mid-match, so a lobby match started
shortly before 22:45 CT delays the start by up to a minute. To stay out of lobby matches while waiting,
set `LOBBY=0` (the bot then only plays the matches the server seats it in):

```
BOT_NAME=Lexiconda STRATEGY=final TOURNAMENT_ID=<id> LOBBY=0 npm run bot
```

Once the tournament starts, `join_lobby` is refused ("You're playing in a tournament") until the bot is
knocked out or it ends; the bot logs the refusal and retries only every 30 s.

## 4. Switch strategy

`STRATEGY=<name>` loads `src/strategies/<name>.ts` (it must export `createStrategy()` returning a
`Strategy`, or a `STRATEGIES` table). Default is `final`. List what exists:

```
ls src/strategies
STRATEGY=economist BOT_NAME=Lexiconda npm run bot
```

Restart the process to switch (strategy state is per process). If the import fails the bot falls back to
the `starter` baseline and says so loudly (a `!!!!` block at startup and `(FALLBACK; wanted ...)`).

## 5. Two processes

Not on one token. Two bots need two credentials (two team bots / tokens) and two different `BOT_NAME`s so
that each writes its own `.token-<BOT_NAME>`. If you only have one bot (Lexiconda), run exactly one process.
Do not run the simulator and the live bot at the same time on the laptop (compute rule: one process at a
time for simulations, `nice -n 19`).

## Other settings

| env | effect |
|---|---|
| `BOT_NAME` | log prefix and token file name (`.token-<BOT_NAME>`) |
| `STRATEGY` | strategy file name, default `final` |
| `TOURNAMENT_ID` | register for this tournament on every connect |
| `LOBBY=0` | never call `join_lobby` |
| `SUBSCRIBE_ALL=1` | use upstream's `subscribeToAllTables()` instead of targeted subscriptions (slow start: the public history is ~1.8M auction rows) |
| `STDB_HOST`, `STDB_DB` | server and database (defaults `https://maincloud.spacetimedb.com`, `scrabblebot`) |

## How it works (short)

* Subscriptions are targeted (own credential, `bot`, `my_rack`, own `match_participant` rows, then five
  queries per match I'm in). If any of them is rejected the process reconnects in all-tables mode.
* On each Open auction in a match I'm in: `strategy.words(view)` runs first, the words are submitted in
  order (not awaited), then `strategy.bid(view')` runs against the optimistic view (word letters spent,
  rewards credited).
* How a bid is sent: the bid is capped to the confirmed balance and sent immediately; if the bid exceeds the
  confirmed balance (word rewards pending), a second `submit_bid` for the full amount follows right behind
  it. The ordering of one connection's reducers on the server was not verified from the SDK source, so the
  code works either way: if the second call is rejected with "Insufficient balance" (`opt-rejected`) the
  capped bid stands and the full bid is re-sent when the word reducers settle. `opt-ok` counts show that the
  server applied them in order.
* The last auction (`bagRemaining == 0`): the strategy's words are played, then whatever is still playable is
  dumped with `bestPartition`, and no bid is sent (the letter is worthless).
* Strategy exceptions are logged (`STRATEGY EXCEPTION`) and replaced by no words / bid 0; the process never
  exits on them. A broken strategy still gets the last-auction dump.
* Disconnects (also hung connects and zombie sockets, via watchdogs) reconnect with backoff 0.5 s doubling to
  10 s.

## Tests

```
nice -n 19 node --import tsx --test src/live/mock.test.ts     # mock-connection flow tests, about 1 s
nice -n 19 npx tsx src/live/replay.ts [matchId]               # offline replay of a real ended match (public SQL, read-only)
npx tsc --noEmit -p .
```
