// Production live client. Runs any Strategy (src/strategies/<STRATEGY>.ts)
// against the real ScrabbleBot server.
//
// First run, with a token from the website:
//   BOT_NAME=<name> BOT_TOKEN=<token> npm run bot
// or with a nonce from the CLI:
//   BOT_NAME=<name> BOT_NONCE=<code> npm run bot
// The token is saved to .token-<BOT_NAME>, so later runs need only BOT_NAME.
//
// Env: STRATEGY (default 'final'), TOURNAMENT_ID (register on connect),
//      LOBBY=0 (do not auto-join lobbies), SUBSCRIBE_ALL=1 (upstream-style
//      subscribeToAllTables), STDB_HOST, STDB_DB.
// See docs/RUNNING.md.
//
// One bot credential per process: never run two processes on one token.

import { loadStrategy } from "./live/strategy_loader.js";
import { configFromEnv, runLive } from "./live/runner.js";

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const requested = process.env.STRATEGY ?? "final";
  const loaded = await loadStrategy(requested);
  console.log(
    `[${cfg.botName}] strategy: ${loaded.loaded}${loaded.fellBack ? ` (FALLBACK; wanted '${requested}')` : ""} -> ${loaded.strategy.name}`,
  );
  await runLive(cfg, loaded.strategy);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
