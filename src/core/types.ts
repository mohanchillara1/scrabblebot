// Shared contract between the simulator (src/sim), the strategies
// (src/strategies) and the live client (src/index.ts). Change only with care:
// every other module codes against this file.

export type AuctionType = "Vickrey" | "FirstPrice";
export type SimStrategyTag = "Cheapskate" | "ValueBidder" | "Aggressive";

export interface PlayerPublic {
  botId: number;
  balance: number; // public on the server (match_participant)
  score: number; // public on the server
  isSim: boolean; // bot.is_simulated, public
  simStrategy?: SimStrategyTag; // bot.strategy for sims, public
}

export interface AuctionRecord {
  round: number;
  letter: string;
  winnerBotId: number | null; // null = no positive bid; letter is discarded
  paid: number; // Vickrey: 2nd-highest bid (or 1 if sole bidder). FirstPrice: winner's bid.
}

export interface WordRecord {
  round: number;
  botId: number;
  word: string;
  reward: number;
}

export interface MatchView {
  matchId: number;
  myBotId: number;
  auctionType: AuctionType;
  auctionDurationMs: number;
  startingRackSize: number;
  players: PlayerPublic[]; // includes me
  myRack: Map<string, number>; // letter -> count, my private holding in this match
  myBalance: number;
  myScore: number;
  round: number; // 1-based round of the auction currently open
  // Letters left in the bag AFTER the open auction's letter was drawn
  // (server: match_state.bag_total). 0 => the open auction is the LAST one:
  // the match ends the instant it closes, so its letter is worthless and
  // every word must be played before it closes.
  bagRemaining: number;
  auctionHistory: AuctionRecord[];
  wordHistory: WordRecord[];
}

export interface Strategy {
  name: string;
  onMatchStart?(view: MatchView): void;
  // Called once per auction, when it opens, BEFORE bid(). Return the words to
  // play right now, in order; together they must be spellable from myRack
  // (letters are consumed). Rewards are credited to balance immediately, so
  // bid() sees the updated balance.
  words(view: MatchView): string[];
  // Called when an auction opens (after words()). Integer >= 0, <= myBalance.
  // 0 = no bid.
  bid(view: MatchView, letter: string): number;
  onAuctionResult?(view: MatchView, rec: AuctionRecord): void;
}
