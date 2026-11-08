// SpacetimeDB glue for the live client: connection + token handling,
// subscriptions, table callbacks -> LiveBot, reducers -> Transport, reconnect.
//
// Subscriptions (default "targeted" mode, avoids downloading the ~1.8M-row
// public history that subscribeToAllTables() pulls):
//   1. bot_credential WHERE identity = <me>          -> my bot id
//   2. bot, my_rack, match_participant WHERE bot_id = <me>
//   3. per match I'm in (new matches found via my match_participant inserts,
//      plus my 3 most recent at connect): match_state, match_participant,
//      auction, auction_result, word_play filtered by match id.
// If any targeted subscription errors, the process falls back to
// subscribeToAllTables() (the upstream starter's behaviour) on the next
// reconnect, logged loudly.

import * as fs from "node:fs";
import * as path from "node:path";
import { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext } from "../module_bindings/index.js";
import type { Strategy } from "../core/types.js";
import * as W from "../engine/words.js";
import { LiveBot, summarizeStats, type Transport } from "./bot.js";
import { LiveStore } from "./store.js";

export interface RunnerConfig {
  host: string;
  dbName: string;
  botName: string;
  token?: string;
  nonce?: string;
  tournamentId?: string;
  autoLobby: boolean;
  forceAllTables: boolean;
  tokenPath: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RunnerConfig {
  const botName = env.BOT_NAME ?? "bot";
  return {
    host: env.STDB_HOST ?? "https://maincloud.spacetimedb.com",
    dbName: env.STDB_DB ?? "scrabblebot",
    botName,
    token: env.BOT_TOKEN,
    nonce: env.BOT_NONCE,
    tournamentId: env.TOURNAMENT_ID,
    autoLobby: env.LOBBY !== "0",
    forceAllTables: env.SUBSCRIBE_ALL === "1",
    tokenPath: path.join(cwd, `.token-${botName}`),
  };
}

const ts = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export function makeLogger(): (line: string) => void {
  return (line) => console.log(`${ts()} ${line}`);
}

function loadToken(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Stall watchdog: reconnect when a running match shows no auction events for this long.
const STALL_MIN_MS = Number(process.env.STALL_MIN_MS ?? 6000);
const STALL_AUCTIONS = 5;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runLive(cfg: RunnerConfig, strategy: Strategy): Promise<never> {
  const log = makeLogger();
  const tag = `[${cfg.botName}]`;

  process.on("uncaughtException", (e) => log(`${tag} UNCAUGHT EXCEPTION (continuing): ${e instanceof Error ? e.stack : e}`));
  process.on("unhandledRejection", (e) => log(`${tag} UNHANDLED REJECTION (continuing): ${e instanceof Error ? e.stack : e}`));

  // Pay the dictionary load (about 350 ms, 100 MB) before any auction.
  try {
    const t0 = Date.now();
    W.warmUp();
    log(`${tag} word engine warm (${Date.now() - t0} ms)`);
  } catch (e) {
    log(`${tag} WARNING: word engine failed to load: ${errMsg(e)}`);
  }

  let mode: "targeted" | "all" = cfg.forceAllTables ? "all" : "targeted";
  let current: DbConnection | null = null;
  let bot: LiveBot | null = null;

  const transport: Transport = {
    submitBid: (auctionId, amount) => {
      if (!current) return Promise.reject(new Error("disconnected"));
      return current.reducers.submitBid({ auctionId, amount: BigInt(Math.max(0, Math.floor(amount))) });
    },
    submitWord: (matchId, word) => {
      if (!current) return Promise.reject(new Error("disconnected"));
      return current.reducers.submitWord({ matchId, word });
    },
    joinLobby: () => {
      if (!current) return Promise.reject(new Error("disconnected"));
      return current.reducers.joinLobby({});
    },
    resync: (matchId) => {
      if (current && bot) syncMatch(current, bot, matchId, false);
    },
  };

  setInterval(() => {
    if (bot && current) bot.maybeJoinLobby("idle check");
  }, 20_000).unref?.();
  setInterval(() => {
    if (bot) log(`${tag} STATS ${summarizeStats(bot.stats)}`);
  }, 120_000).unref?.();

  process.on("SIGINT", () => {
    if (bot) log(`${tag} FINAL STATS ${summarizeStats(bot.stats)}`);
    process.exit(0);
  });

  let backoff = 500;
  for (;;) {
    const startedAt = Date.now();
    log(`${tag} connecting to ${cfg.dbName} at ${cfg.host} (subscribe mode: ${mode}, strategy: ${strategy.name})`);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (why: string) => {
        if (finished) return;
        finished = true;
        log(`${tag} connection ended: ${why}`);
        current = null;
        resolve();
      };
      try {
        session(finish);
      } catch (e) {
        finish(`session setup threw: ${errMsg(e)}`);
      }
    });
    if (Date.now() - startedAt > 30_000) backoff = 500;
    log(`${tag} reconnecting in ${backoff} ms`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 10_000);
  }

  // ------------------------------------------------------------------
  function session(finish: (why: string) => void): void {
    let myBotId: bigint | null = null;
    let ready = false; // table callbacks feed the bot only when true
    let settled = false; // afterReady() ran and the initial-row callbacks are done: new matches may now be tracked
    let minTrackId = 0n; // never track matches older than my most recent few
    const tracked = new Set<bigint>();
    const interest = new Set<bigint>(); // all-tables mode: matches I'm in

    const accept = (matchId: bigint) => mode === "targeted" || interest.has(matchId);
    let connected = false;
    let lastAuctionAt = Date.now(); // last auction insert/update or result seen on this connection (stall watchdog)
    let stopTimersRef: () => void = () => {};
    const finishOuter = finish;
    finish = (why: string) => {
      stopTimersRef();
      finishOuter(why);
    };

    const builder = DbConnection.builder()
      .withUri(cfg.host)
      .withDatabaseName(cfg.dbName)
      .withToken(cfg.token ?? loadToken(cfg.tokenPath))
      .onConnect((conn, identity, token) => {
        connected = true;
        current = conn;
        try {
          fs.writeFileSync(cfg.tokenPath, token);
        } catch (e) {
          log(`${tag} could not save token: ${errMsg(e)}`);
        }
        log(`${tag} connected as ${identity.toHexString()}`);
        wire(conn, identity);
      })
      .onConnectError((_ctx: ErrorContext, err: Error) => finish(`connect error: ${err.message}`))
      .onDisconnect((_ctx: ErrorContext, err?: Error) => finish(err ? `disconnected: ${err.message}` : "disconnected"));
    const conn0 = builder.build();
    // Watchdogs: the SDK reports most failures, but a refused/hung connect or a zombie socket must not leave us offline.
    const connectTimer = setTimeout(() => {
      if (!connected) {
        try {
          conn0.disconnect();
        } catch {
          /* ignore */
        }
        finish("connect timeout (15 s)");
      }
    }, 15_000);
    const liveness = setInterval(() => {
      if (connected && (conn0.isSocketClosed || conn0.isActive === false)) {
        try {
          conn0.disconnect();
        } catch {
          /* ignore */
        }
        finish("socket closed (watchdog)");
        return;
      }
      // Half-open socket: seen live 2026-11-07 21:20, the SDK kept the socket "open" but delivered no rows for
      // 8 minutes while our match ran to the end. In a running match an auction closes every auctionDurationMs,
      // so silence much longer than that means the connection is dead: reconnect and resync.
      if (connected && ready && bot) {
        const running = bot.runningMatchIds();
        if (running.length > 0) {
          let durMs = 1000;
          for (const id of running) {
            const d = Number((bot as unknown as { store?: { matches?: Map<bigint, { auctionDurationMs?: unknown }> } })
              .store?.matches?.get(id)?.auctionDurationMs ?? 1000);
            if (Number.isFinite(d)) durMs = Math.max(durMs, d);
          }
          const stallMs = Math.max(STALL_MIN_MS, STALL_AUCTIONS * durMs);
          if (Date.now() - lastAuctionAt > stallMs) {
            try {
              conn0.disconnect();
            } catch {
              /* ignore */
            }
            finish(`no auction events for ${Date.now() - lastAuctionAt} ms in a running match (stall watchdog)`);
          }
        }
      }
    }, 1_000);
    let regTimer: ReturnType<typeof setInterval> | undefined;
    const stopTimers = () => {
      clearTimeout(connectTimer);
      clearInterval(liveness);
      if (regTimer) clearInterval(regTimer);
    };
    stopTimersRef = stopTimers;

    function subscribe(name: string, queries: string[], onApplied: () => void, onFail?: () => void): void {
      const conn = current!;
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          try {
            onApplied();
          } catch (e) {
            log(`${tag} ERROR in onApplied(${name}): ${errMsg(e)}`);
          }
        })
        .onError((ctx) => {
          log(`${tag} SUBSCRIPTION ERROR (${name}): ${ctx.event?.message ?? "unknown"}  queries=${JSON.stringify(queries)}`);
          if (onFail) onFail();
          else fallBackToAll(`subscription '${name}' failed`);
        })
        .subscribe(queries);
    }

    function fallBackToAll(why: string): void {
      if (mode === "all") return;
      mode = "all";
      log(`${tag} !!!! falling back to subscribeToAllTables(): ${why}. Reconnecting in all-tables mode (slow start).`);
      try {
        current?.disconnect();
      } catch {
        /* ignore */
      }
      finish("fallback to all-tables mode");
    }

    function resolveBotId(conn: DbConnection, identity: Identity): bigint | null {
      const cred = conn.db.botCredential.identity.find(identity);
      return cred ? cred.botId : null;
    }

    function trackMatch(conn: DbConnection, matchId: bigint): void {
      if (tracked.has(matchId)) return;
      tracked.add(matchId);
      const m = String(matchId);
      subscribe(
        `match ${m}`,
        [
          `SELECT * FROM match_state WHERE id = ${m}`,
          `SELECT * FROM match_participant WHERE match_id = ${m}`,
          `SELECT * FROM auction WHERE match_id = ${m}`,
          `SELECT * FROM auction_result WHERE match_id = ${m}`,
          `SELECT * FROM word_play WHERE match_id = ${m}`,
        ],
        () => {
          if (bot) syncMatch(conn, bot, matchId, true);
        },
      );
    }

    function afterReady(conn: DbConnection): void {
      if (!bot || myBotId === null) return;
      const b = bot;
      const myId = myBotId;
      const name = conn.db.bot.id.find(myId)?.name ?? "?";
      log(`${tag} acting as bot '${name}' (id ${myId})`);
      // Which matches am I in? The most recent few cover a mid-match reconnect.
      const mine: bigint[] = [];
      for (const p of conn.db.matchParticipant.iter()) if (p.botId === myId) mine.push(p.matchId);
      mine.sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
      const recent = mine.slice(0, 3);
      for (const id of recent) interest.add(id);
      if (mode === "targeted") for (const id of recent) trackMatch(conn, id);
      else for (const id of recent) syncMatch(conn, b, id, true);
      // The SDK emits 'applied' BEFORE it dispatches the insert callbacks for the initial rows, so
      // flip `settled` only after those callbacks ran, or every historical match of mine would get tracked.
      minTrackId = recent.length > 0 ? recent[recent.length - 1]! : 0n;
      setTimeout(() => {
        settled = true;
      }, 0);
      if (cfg.tournamentId) {
        // Registration is retried every 15 s until it succeeds (or the server says we are already in), so a bot
        // that connects before the admin opens registration, or a transient error, still gets entered.
        // A non-numeric id is reported once and must not stop the startup lobby join below.
        let tid: bigint | null = null;
        try {
          tid = BigInt(cfg.tournamentId.trim());
        } catch {
          log(`${tag} TOURNAMENT_ID '${cfg.tournamentId}' is not a number; NOT registering`);
        }
        if (tid !== null) {
          const id = tid;
          let done = false;
          let tries = 0;
          const attempt = (): void => {
            if (done || current !== conn) return;
            tries++;
            try {
              conn.reducers
                .registerForTournament({ tournamentId: id })
                .then(() => {
                  done = true;
                  if (regTimer) clearInterval(regTimer);
                  log(`${tag} registered for tournament ${id}`);
                })
                .catch((e) => {
                  const m = errMsg(e);
                  if (/already/i.test(m)) {
                    done = true;
                    if (regTimer) clearInterval(regTimer);
                  }
                  if (tries <= 3 || tries % 20 === 0) log(`${tag} tournament ${id} registration (try ${tries}): ${m}`);
                });
            } catch (e) {
              log(`${tag} tournament ${id} registration threw (try ${tries}): ${errMsg(e)}`);
            }
          };
          if (regTimer) clearInterval(regTimer);
          attempt();
          regTimer = setInterval(attempt, 15_000);
        }
      }
      setTimeout(() => b.maybeJoinLobby("startup"), 1500);
    }

    function wire(conn: DbConnection, identity: Identity): void {
      const hex = identity.toHexString();
      const feed = <A extends unknown[]>(matchIdOf: (...a: A) => bigint | undefined, fn: (...a: A) => void) =>
        (...args: A): void => {
          if (!ready || !bot) return;
          try {
            const mid = matchIdOf(...args);
            if (mid !== undefined && !accept(mid)) return;
            fn(...args);
          } catch (e) {
            log(`${tag} ERROR ingesting row: ${errMsg(e)}`);
          }
        };
      const db = conn.db;
      db.bot.onInsert((_c, r) => {
        if (ready && bot) bot.onBot(r);
      });
      db.bot.onUpdate((_c, _o, r) => {
        if (ready && bot) bot.onBot(r);
      });
      db.matchState.onInsert(feed((_c, r) => r.id, (_c, r) => bot!.onMatchState(r)));
      db.matchState.onUpdate(feed((_c, _o, r) => r.id, (_c, _o, r) => bot!.onMatchState(r)));
      db.matchParticipant.onInsert(
        feed(
          (_c, r) => (r.botId === myBotId ? undefined : r.matchId),
          (_c, r) => {
            bot!.onParticipant(r);
            if (r.botId === myBotId && settled && r.matchId >= minTrackId) {
              if (mode === "targeted") {
                trackMatch(conn, r.matchId);
              } else if (!interest.has(r.matchId)) {
                interest.add(r.matchId);
                syncMatch(conn, bot!, r.matchId, true);
              }
            }
          },
        ),
      );
      db.matchParticipant.onUpdate(feed((_c, _o, r) => r.matchId, (_c, _o, r) => bot!.onParticipant(r)));
      db.matchParticipant.onDelete(feed((_c, r) => r.matchId, (_c, r) => bot!.onParticipantRemoved(r)));
      db.myRack.onInsert(feed((_c, r) => r.matchId, (_c, r) => bot!.onRack(r)));
      db.myRack.onUpdate(feed((_c, _o, r) => r.matchId, (_c, _o, r) => bot!.onRack(r)));
      db.myRack.onDelete(feed((_c, r) => r.matchId, (_c, r) => bot!.onRackRemoved(r)));
      db.auction.onInsert(() => {
        lastAuctionAt = Date.now();
      });
      db.auction.onUpdate(() => {
        lastAuctionAt = Date.now();
      });
      db.auctionResult.onInsert(() => {
        lastAuctionAt = Date.now();
      });
      db.auction.onInsert(feed((_c, r) => r.matchId, (_c, r) => bot!.onAuction(r)));
      db.auction.onUpdate(feed((_c, _o, r) => r.matchId, (_c, _o, r) => bot!.onAuction(r)));
      db.auctionResult.onInsert(feed((_c, r) => r.matchId, (_c, r) => bot!.onResult(r)));
      db.wordPlay.onInsert(feed((_c, r) => r.matchId, (_c, r) => bot!.onWord(r)));

      const onCredential = (): void => {
        if (myBotId !== null) return;
        myBotId = resolveBotId(conn, identity);
        if (myBotId === null) return;
        if (!bot) {
          bot = new LiveBot({
            strategy,
            transport,
            store: new LiveStore(myBotId),
            name: cfg.botName,
            log,
            autoLobby: cfg.autoLobby,
          });
        } else {
          bot.resetSession();
          bot.store.myBotId = myBotId;
        }
        ready = true;
        if (mode === "targeted") {
          subscribe(
            "base",
            [`SELECT * FROM bot`, `SELECT * FROM my_rack`, `SELECT * FROM match_participant WHERE bot_id = ${myBotId}`],
            () => afterReady(conn),
          );
        }
      };
      db.botCredential.onInsert(() => onCredential());

      const afterCredentialApplied = (): void => {
        onCredential();
        if (myBotId === null) {
          if (cfg.nonce) {
            log(`${tag} claiming credential with nonce...`);
            conn.reducers.claimCredential({ code: cfg.nonce }).catch((e) => log(`${tag} claiming the credential failed: ${errMsg(e)}`));
            setTimeout(() => {
              onCredential();
              if (myBotId === null) {
                log(`${tag} FATAL: could not claim credential (bad / expired nonce?)`);
                process.exit(1);
              }
            }, 1500);
          } else {
            log(`${tag} FATAL: no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`);
            process.exit(1);
          }
        } else if (mode === "all") {
          afterReady(conn);
        }
      };

      if (mode === "targeted") {
        subscribe(
          "credential",
          [`SELECT * FROM bot_credential WHERE identity = 0x${hex}`],
          afterCredentialApplied,
          () => {
            // Filtered form rejected: use the unfiltered table (small).
            log(`${tag} retrying credential subscription unfiltered`);
            subscribe("credential-all", [`SELECT * FROM bot_credential`], afterCredentialApplied);
          },
        );
      } else {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            log(`${tag} all-tables subscription applied`);
            afterCredentialApplied();
          })
          .onError((ctx) => log(`${tag} all-tables SUBSCRIPTION ERROR: ${ctx.event?.message ?? "unknown"}`))
          .subscribeToAllTables();
      }
    }
  }
}

/**
 * Pull the cache rows of one match into the bot's store.
 * `full` also re-feeds auctions/results/words (match discovery, mid-match reconnect);
 * the light form (after a reducer failure) refreshes only balance/score/rack/status.
 */
export function syncMatch(conn: DbConnection, bot: LiveBot, matchId: bigint, full: boolean): void {
  const ms = conn.db.matchState.id.find(matchId);
  if (ms) bot.onMatchState(ms);
  for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId) bot.onParticipant(p);
  const rackRows = [];
  for (const r of conn.db.myRack.iter()) if (r.matchId === matchId) rackRows.push(r);
  bot.replaceRack(matchId, rackRows);
  if (!full) return;
  for (const w of conn.db.wordPlay.iter()) if (w.matchId === matchId) bot.onWord(w);
  for (const r of conn.db.auctionResult.iter()) if (r.matchId === matchId) bot.onResult(r);
  for (const a of conn.db.auction.iter()) if (a.matchId === matchId) bot.onAuction(a);
}
