export interface GameTally {
  wins: number;
  losses: number;
  draws: number;
}

export interface EloEstimate {
  games: number;
  score: number;
  scoreRate: number;
  elo: number;
  ci95: {
    low: number;
    high: number;
  };
}

export interface SprtConfig {
  /** Null hypothesis Elo difference. */
  elo0: number;
  /** Alternative hypothesis Elo difference. */
  elo1: number;
  /** Type-I error rate. Default 0.05. */
  alpha?: number;
  /** Type-II error rate. Default 0.05. */
  beta?: number;
}

export interface SprtReport {
  games: number;
  llr: number;
  lowerBoundary: number;
  upperBoundary: number;
  decision: "accept-h0" | "accept-h1" | "continue";
  elo0: number;
  elo1: number;
  alpha: number;
  beta: number;
}

export function summarizeElo(tally: GameTally): EloEstimate {
  const games = tally.wins + tally.losses + tally.draws;
  const score = tally.wins + tally.draws * 0.5;
  const scoreRate = games > 0 ? score / games : 0.5;
  const interval = wilsonInterval(scoreRate, games);
  return {
    games,
    score,
    scoreRate,
    elo: scoreRateToElo(scoreRate),
    ci95: {
      low: scoreRateToElo(interval.low),
      high: scoreRateToElo(interval.high),
    },
  };
}

export function runSprt(tally: GameTally, config: SprtConfig): SprtReport {
  const alpha = config.alpha ?? 0.05;
  const beta = config.beta ?? 0.05;
  const p0 = eloToScoreRate(config.elo0);
  const p1 = eloToScoreRate(config.elo1);
  const score = tally.wins + tally.draws * 0.5;
  const misses = tally.losses + tally.draws * 0.5;
  const llr = score * Math.log(p1 / p0) + misses * Math.log((1 - p1) / (1 - p0));
  const upperBoundary = Math.log((1 - beta) / alpha);
  const lowerBoundary = Math.log(beta / (1 - alpha));
  return {
    games: tally.wins + tally.losses + tally.draws,
    llr,
    lowerBoundary,
    upperBoundary,
    decision: llr >= upperBoundary ? "accept-h1" : llr <= lowerBoundary ? "accept-h0" : "continue",
    elo0: config.elo0,
    elo1: config.elo1,
    alpha,
    beta,
  };
}

export function scoreRateToElo(scoreRate: number): number {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, scoreRate));
  return Math.round(400 * Math.log10(p / (1 - p)));
}

export function eloToScoreRate(elo: number): number {
  return 1 / (1 + 10 ** (-elo / 400));
}

function wilsonInterval(scoreRate: number, games: number): { low: number; high: number } {
  if (games <= 0) return { low: 0.5, high: 0.5 };
  const z = 1.959963984540054;
  const z2 = z * z;
  const denominator = 1 + z2 / games;
  const center = (scoreRate + z2 / (2 * games)) / denominator;
  const margin = (z * Math.sqrt((scoreRate * (1 - scoreRate)) / games + z2 / (4 * games * games))) / denominator;
  return {
    low: Math.max(1e-6, center - margin),
    high: Math.min(1 - 1e-6, center + margin),
  };
}
