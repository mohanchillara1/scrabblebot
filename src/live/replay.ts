// OFFLINE replay of a real ended match through the live view-builder.
//
//   nice -n 19 npx tsx src/live/replay.ts [matchId]
//
// Pulls one ended all-real match from the public SQL endpoint (read-only; an
// anonymous token from POST /v1/identity), then feeds the rows to a LiveBot in
// the order a connected client would see them (auction opens -> bids -> close),
// with "me" = the match winner. Per round it checks the MatchView the strategy
// receives against an independent reconstruction from the raw rows:
//   round, bagRemaining, auction/word histories, every player's balance and
//   score (balance = 100 - sum(paid) + sum(word rewards), score = sum(rewards)),
//   my rack (letters won minus letters played, plus the inferred start rack),
// and finally against the stored final match_participant balance/score.
// Exits non-zero on any mismatch.

import type { AuctionRecord, MatchView, Strategy } from "../core/types.js";
import { LiveBot, type Transport } from "./bot.js";
import { LiveStore, num, type AuctionRow, type ResultRow, type WordRow } from "./store.js";

const HOST = "https://maincloud.spacetimedb.com/v1";
const DB = "scrabblebot";

// ---------- SQL plumbing ----------

let TOKEN = "";
async function token(): Promise<string> {
  if (TOKEN) return TOKEN;
  const r = await fetch(`${HOST}/identity`, { method: "POST" });
  TOKEN = ((await r.json()) as { token: string }).token;
  return TOKEN;
}

type Row = Record<string, unknown>;

function decode(type: any, v: any): unknown {
  if (type.U64 || type.I64 || type.U32 || type.I32 || type.U8 || type.U16 || type.I16 || type.I8 || type.U128 || type.I128) {
    const n = BigInt(v);
    return type.U32 || type.I32 || type.U8 || type.U16 ? Number(n) : n;
  }
  if (type.Sum) {
    const variants = type.Sum.variants as { name: { some: string }; algebraic_type: any }[];
    const [idx, payload] = v as [number, unknown[]];
    const variant = variants[idx]!;
    const name = variant.name.some;
    if (name === "some") return decode(variant.algebraic_type, payload);
    if (name === "none") return undefined;
    return { tag: name.charAt(0).toUpperCase() + name.slice(1) };
  }
  if (type.Product) {
    const els = type.Product.elements as { name?: { some: string }; algebraic_type: any }[];
    if (els.length === 1 && els[0]!.name?.some === "__timestamp_micros_since_unix_epoch__") {
      return { microsSinceUnixEpoch: BigInt((v as unknown[])[0] as number) };
    }
    return v;
  }
  return v;
}

async function sql(q: string): Promise<Row[]> {
  const res = await fetch(`${HOST}/database/${DB}/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}` },
    body: q,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL failed (${res.status}): ${text.slice(0, 200)}  query=${q}`);
  const out = (JSON.parse(text) as { schema: { elements: { name: { some: string }; algebraic_type: any }[] }; rows: unknown[][] }[])[0]!;
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return out.rows.map((r) => {
    const o: Row = {};
    out.schema.elements.forEach((el, i) => (o[camel(el.name.some)] = decode(el.algebraic_type, r[i])));
    return o;
  });
}

// ---------- the replay ----------

class Failures {
  list: string[] = [];
  checks = 0;
  eq(what: string, got: unknown, want: unknown): void {
    this.checks++;
    const g = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    const w = JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    if (g !== w) this.list.push(`${what}: got ${g} want ${w}`);
  }
}

function addLetters(m: Map<string, number>, s: string, sign: 1 | -1): void {
  for (const c of s) {
    const n = (m.get(c) ?? 0) + sign;
    if (n === 0) m.delete(c);
    else m.set(c, n);
  }
}

export async function replay(requestedId?: number): Promise<{ matchId: number; rounds: number; checks: number; failures: string[] }> {
  const fail = new Failures();
  const bots = (await sql("SELECT * FROM bot")) as unknown as { id: bigint; isSimulated: boolean; strategy: { tag: string } }[];
  const simIds = new Set(bots.filter((b) => b.isSimulated).map((b) => b.id));

  // Pick a match.
  let matchRow: Row | undefined;
  let parts: Row[] = [];
  if (requestedId !== undefined) {
    matchRow = (await sql(`SELECT * FROM match_state WHERE id = ${requestedId}`))[0];
  } else {
    let lo = 26_000;
    for (;;) {
      const n = await sql(`SELECT id FROM match_state WHERE id > ${lo + 2000} LIMIT 1`);
      if (n.length === 0) break;
      lo += 2000;
    }
    const recent = (await sql(`SELECT * FROM match_state WHERE id > ${lo} LIMIT 3000`)).filter((r) => (r.status as { tag: string }).tag === "Ended");
    recent.sort((a, b) => ((a.id as bigint) < (b.id as bigint) ? 1 : -1));
    for (const m of recent.slice(0, 40)) {
      const p = await sql(`SELECT * FROM match_participant WHERE match_id = ${m.id}`);
      if (p.length === 6 && p.every((x) => !simIds.has(x.botId as bigint))) {
        matchRow = m;
        parts = p;
        break;
      }
    }
  }
  if (!matchRow) throw new Error("no suitable ended match found");
  const matchId = matchRow.id as bigint;
  if (parts.length === 0) parts = await sql(`SELECT * FROM match_participant WHERE match_id = ${matchId}`);
  const auctions = (await sql(`SELECT * FROM auction WHERE match_id = ${matchId}`)) as unknown as AuctionRow[];
  const results = (await sql(`SELECT * FROM auction_result WHERE match_id = ${matchId}`)) as unknown as ResultRow[];
  const wordRows = (await sql(`SELECT * FROM word_play WHERE match_id = ${matchId}`)) as unknown as WordRow[];
  auctions.sort((a, b) => (a.id < b.id ? -1 : 1));
  results.sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1));
  wordRows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const P = parts.length;
  const startRack = num(matchRow.startingRackSize as number);
  console.log(`replaying match ${matchId}: ${P} players, ${auctions.length} auctions, ${wordRows.length} words, ${matchRow.auctionType ? (matchRow.auctionType as { tag: string }).tag : "?"}`);

  // "me" = the winner of the match.
  const me = [...parts].sort((a, b) => num(b.score as bigint) - num(a.score as bigint))[0]!.botId as bigint;
  console.log(`me = bot ${me} (final score ${num(parts.find((p) => p.botId === me)!.score as bigint)})`);

  // Independent reconstruction (plain arrays, no LiveStore code).
  const closedAtOf = new Map<bigint, bigint>(results.map((r) => [r.auctionId, r.closedAt!.microsSinceUnixEpoch]));
  const bal = new Map<bigint, number>(parts.map((p) => [p.botId as bigint, 100]));
  const score = new Map<bigint, number>(parts.map((p) => [p.botId as bigint, 0]));
  const racks = new Map<bigint, Map<string, number>>(parts.map((p) => [p.botId as bigint, new Map()]));
  // Inferred start rack for me (hidden on the server): minimal letters that make all my words spellable.
  const myStart = new Map<string, number>();

  // Recording strategy: captures every view it is given.
  const seen: { words: MatchView[]; bids: MatchView[]; results: { view: MatchView; rec: AuctionRecord }[] } = { words: [], bids: [], results: [] };
  const strategy: Strategy = {
    name: "replay-recorder",
    words(v) {
      seen.words.push(v);
      return [];
    },
    bid(v) {
      seen.bids.push(v);
      return 0;
    },
    onAuctionResult(v, rec) {
      seen.results.push({ view: v, rec });
    },
  };
  const transport: Transport = {
    submitBid: async () => {},
    submitWord: async () => {},
    joinLobby: async () => {},
  };
  const store = new LiveStore(me);
  const bot = new LiveBot({ strategy, transport, store, log: () => {}, autoLobby: false });
  for (const b of bots) bot.onBot(b as never);

  const totalBag = 98;
  let wi = 0; // next word row to release
  const wordsVisibleBy = (t: bigint) => wordRows.filter((w) => w.playedAt!.microsSinceUnixEpoch <= t);
  void wordsVisibleBy;

  const releaseWords = (t: bigint, inclusive: boolean): void => {
    while (wi < wordRows.length) {
      const pt = wordRows[wi]!.playedAt!.microsSinceUnixEpoch;
      if (inclusive ? pt > t : pt >= t) break;
      const w = wordRows[wi++]!;
      bot.onWord(w);
      bal.set(w.botId, bal.get(w.botId)! + num(w.totalReward));
      score.set(w.botId, score.get(w.botId)! + num(w.totalReward));
      const rk = racks.get(w.botId)!;
      if (w.botId === me) {
        const need = new Map<string, number>();
        for (const c of w.word) need.set(c, (need.get(c) ?? 0) + 1);
        for (const [c, n] of need) {
          const lack = n - (rk.get(c) ?? 0);
          if (lack > 0) {
            myStart.set(c, (myStart.get(c) ?? 0) + lack); // hidden start tile(s)
            rk.set(c, (rk.get(c) ?? 0) + lack);
          }
        }
      }
      addLetters(rk, w.word, -1);
    }
  };

  // Words are "visible" in the next view once played. Walk rounds.
  for (let r = 1; r <= auctions.length; r++) {
    const a = auctions[r - 1]!;
    const opens = a.opensAt!.microsSinceUnixEpoch;
    // Release (feed + apply to reference) every word played at or before this auction's open.
    releaseWords(opens, true);
    // Feed the table state a client would hold when this auction inserts.
    const bagTotal = totalBag - P * startRack - r;
    bot.onMatchState({
      id: matchId,
      status: { tag: "Running" },
      currentRound: r,
      bagTotal,
      auctionType: matchRow.auctionType as { tag: string },
      auctionDurationMs: matchRow.auctionDurationMs as bigint,
      startingRackSize: startRack,
    });
    for (const p of parts) {
      const id = p.botId as bigint;
      bot.onParticipant({ matchId, botId: id, balance: BigInt(bal.get(id)!), score: BigInt(score.get(id)!) });
    }
    // My rack rows: start rack inferred so far + won letters - played letters (reference racks include start letters added lazily).
    const myRack = racks.get(me)!;
    const rows = [...myRack].map(([letter, count], i) => ({ id: BigInt(i + 1), matchId, botId: me, letter, count }));
    bot.replaceRack(matchId, rows);
    const nBefore = seen.bids.length;
    const nWordsBefore = seen.words.length;
    bot.onAuction({ ...a, status: { tag: "Open" } }); // historical rows are Closed; replay the insert
    await bot.idle();

    const v = seen.words[nWordsBefore];
    if (!v) {
      fail.list.push(`round ${r}: strategy.words was not called`);
      continue;
    }
    // bid() is called on every auction except the last (bagRemaining 0), where the live bot never bids.
    fail.eq(`round ${r} bid() calls`, seen.bids.length - nBefore, bagTotal === 0 ? 0 : 1);
    if (bagTotal > 0) fail.eq(`round ${r} bid view == words view`, seen.bids[nBefore]!.myBalance, v.myBalance);
    fail.eq(`round ${r} round`, v.round, r);
    fail.eq(`round ${r} bagRemaining`, v.bagRemaining, bagTotal);
    fail.eq(`round ${r} matchId`, v.matchId, num(matchId));
    fail.eq(`round ${r} auctionType`, v.auctionType, (matchRow.auctionType as { tag: string }).tag);
    fail.eq(`round ${r} myBalance`, v.myBalance, bal.get(me));
    fail.eq(`round ${r} myScore`, v.myScore, score.get(me));
    fail.eq(`round ${r} players`, v.players.map((p) => [p.botId, p.balance, p.score]), [...parts].map((p) => [num(p.botId as bigint), bal.get(p.botId as bigint), score.get(p.botId as bigint)]).sort((x, y) => (x[0] as number) - (y[0] as number)));
    fail.eq(`round ${r} myRack`, [...v.myRack].sort(), [...myRack].sort());
    fail.eq(`round ${r} auctionHistory`, v.auctionHistory, results.slice(0, r - 1).map((x, i) => ({ round: i + 1, letter: x.letter, winnerBotId: x.winnerBotId === undefined ? null : num(x.winnerBotId), paid: num(x.paid) })));
    fail.eq(`round ${r} wordHistory count`, v.wordHistory.length, wi);
    // Round of a word = last auction opened strictly before it was played (independent of result timestamps).
    fail.eq(
      `round ${r} wordHistory rounds`,
      v.wordHistory.map((w) => [w.word, w.round, w.botId]),
      wordRows.slice(0, wi).map((w) => {
        let rr = 1;
        auctions.forEach((x, i) => {
          if (x.opensAt!.microsSinceUnixEpoch < w.playedAt!.microsSinceUnixEpoch) rr = i + 1;
        });
        return [w.word.toUpperCase(), rr, num(w.botId)];
      }),
    );

    // Close the auction: the result row arrives, then the winner's balance/rack update.
    const res = results[r - 1]!;
    // Words a bot played during this round (before the close) were credited before the winner paid.
    releaseWords(res.closedAt!.microsSinceUnixEpoch, false);
    const winner = res.winnerBotId;
    const paid = num(res.paid);
    if (winner !== undefined && winner !== null) {
      const have = bal.get(winner)!;
      if (have >= paid) {
        bal.set(winner, have - paid);
        addLetters(racks.get(winner)!, res.letter, 1);
      } else fail.list.push(`round ${r}: winner ${winner} could not afford ${paid} (balance ${have})`);
    }
    const nRes = seen.results.length;
    // Participant update first, as in one transaction, then the result row.
    for (const p of parts) {
      const id = p.botId as bigint;
      bot.onParticipant({ matchId, botId: id, balance: BigInt(bal.get(id)!), score: BigInt(score.get(id)!) });
    }
    const myRows = [...racks.get(me)!].map(([letter, count], i) => ({ id: BigInt(i + 1), matchId, botId: me, letter, count }));
    bot.replaceRack(matchId, myRows);
    bot.onResult(res);
    bot.onAuction({ ...a, status: { tag: "Closed" } });
    await bot.idle();
    fail.eq(`round ${r} onAuctionResult called once`, seen.results.length, nRes + 1);
    const got = seen.results[nRes];
    if (got) {
      fail.eq(`round ${r} onAuctionResult.rec`, got.rec, { round: r, letter: res.letter, winnerBotId: winner === undefined || winner === null ? null : num(winner), paid });
      fail.eq(`round ${r} onAuctionResult view balance`, got.view.myBalance, bal.get(me));
    }
  }

  // Remaining words (played in the last auction, after the final open) and the final totals.
  while (wi < wordRows.length) {
    const w = wordRows[wi++]!;
    bal.set(w.botId, bal.get(w.botId)! + num(w.totalReward));
    score.set(w.botId, score.get(w.botId)! + num(w.totalReward));
  }
  for (const p of parts) {
    const id = p.botId as bigint;
    fail.eq(`FINAL balance bot ${id}`, bal.get(id), num(p.balance as bigint));
    fail.eq(`FINAL score bot ${id}`, score.get(id), num(p.score as bigint));
  }
  const startCount = [...myStart.values()].reduce((x, y) => x + y, 0);
  fail.eq(`inferred start rack <= ${startRack} tiles`, startCount <= startRack, true);
  void closedAtOf;

  return { matchId: num(matchId), rounds: auctions.length, checks: fail.checks, failures: fail.list };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  replay(process.argv[2] ? Number(process.argv[2]) : undefined)
    .then((r) => {
      console.log(`match ${r.matchId}: ${r.rounds} rounds, ${r.checks} checks, ${r.failures.length} failures`);
      for (const f of r.failures.slice(0, 30)) console.log("  FAIL", f);
      process.exit(r.failures.length ? 1 : 0);
    })
    .catch((e) => {
      console.error("replay error:", e);
      process.exit(2);
    });
}
