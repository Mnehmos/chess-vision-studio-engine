import type { SprtConfig, SprtReport, EloEstimate, GameTally } from "./stats.js";
import { runSprt, summarizeElo } from "./stats.js";

export interface GauntletGame {
  result: "1-0" | "0-1" | "1/2-1/2";
  /** Which side this engine played in the game. */
  engineColor: "white" | "black";
  opponent: string;
  openingId?: string;
  mirroredPairId?: string;
  pgnPath?: string;
  uciLogPath?: string;
}

export interface GauntletConfig {
  name?: string;
  engine: string;
  engineVersion?: string;
  opponent: string;
  opponentVersion?: string;
  timeControl: string;
  openings?: string;
  seed?: number | string;
  hashMb?: number;
  threads?: number;
  tablebases?: string;
  policyOrdering?: boolean;
  adjudication?: string;
  sprt?: SprtConfig;
}

export interface GauntletReport {
  kind: "gauntlet";
  name: string;
  config: GauntletConfig;
  games: number;
  tally: GameTally;
  elo: EloEstimate;
  sprt?: SprtReport;
  pairedOpenings: boolean;
  artifactPaths: {
    pgn: string[];
    uciLogs: string[];
  };
}

export function summarizeGauntlet(config: GauntletConfig, games: GauntletGame[]): GauntletReport {
  const tally = tallyGames(games);
  const pgn = unique(games.map((game) => game.pgnPath).filter((path): path is string => Boolean(path)));
  const uciLogs = unique(games.map((game) => game.uciLogPath).filter((path): path is string => Boolean(path)));
  return {
    kind: "gauntlet",
    name: config.name ?? `${config.engine}-vs-${config.opponent}`,
    config,
    games: games.length,
    tally,
    elo: summarizeElo(tally),
    sprt: config.sprt ? runSprt(tally, config.sprt) : undefined,
    pairedOpenings: hasMirroredPairs(games),
    artifactPaths: {
      pgn,
      uciLogs,
    },
  };
}

function tallyGames(games: GauntletGame[]): GameTally {
  const tally: GameTally = { wins: 0, losses: 0, draws: 0 };
  for (const game of games) {
    if (game.result === "1/2-1/2") {
      tally.draws++;
    } else if (
      (game.result === "1-0" && game.engineColor === "white") ||
      (game.result === "0-1" && game.engineColor === "black")
    ) {
      tally.wins++;
    } else {
      tally.losses++;
    }
  }
  return tally;
}

function hasMirroredPairs(games: GauntletGame[]): boolean {
  const pairs = new Map<string, Set<"white" | "black">>();
  for (const game of games) {
    if (!game.mirroredPairId) continue;
    const colors = pairs.get(game.mirroredPairId) ?? new Set<"white" | "black">();
    colors.add(game.engineColor);
    pairs.set(game.mirroredPairId, colors);
  }
  return pairs.size > 0 && [...pairs.values()].every((colors) => colors.has("white") && colors.has("black"));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
