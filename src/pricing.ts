import type { TokenTotals } from './types.js';

/**
 * Published list prices in USD per million tokens. These move, and swarmboard has no
 * network access, so every number the UI derives from this table is labelled "estimate".
 *
 * Cache writes bill at 1.25x the input rate, cache reads at 0.1x.
 */
export interface Rate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Matched longest-prefix-first against the model id on the transcript line. */
const TABLE: Array<[string, Rate]> = [
  ['claude-opus', { input: 15, output: 75 }],
  ['claude-fable', { input: 15, output: 75 }],
  ['claude-sonnet', { input: 3, output: 15 }],
  ['claude-haiku', { input: 0.8, output: 4 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
  ['claude-3-opus', { input: 15, output: 75 }],
];

export const FALLBACK_RATE: Rate = { input: 3, output: 15 };

export function rateFor(model: string | null | undefined): Rate {
  if (!model) return FALLBACK_RATE;
  const id = model.toLowerCase();
  let best: Rate | null = null;
  let bestLen = -1;
  for (const [prefix, rate] of TABLE) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = rate;
      bestLen = prefix.length;
    }
  }
  return best ?? FALLBACK_RATE;
}

/** Estimated USD for one usage block. */
export function estimateCost(model: string | null | undefined, tokens: TokenTotals): number {
  const rate = rateFor(model);
  const millions = (n: number) => n / 1_000_000;
  return (
    millions(tokens.input) * rate.input +
    millions(tokens.cacheCreate) * rate.input * CACHE_WRITE_MULTIPLIER +
    millions(tokens.cacheRead) * rate.input * CACHE_READ_MULTIPLIER +
    millions(tokens.output) * rate.output
  );
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

export function addTokens(into: TokenTotals, from: TokenTotals): TokenTotals {
  into.input += from.input;
  into.output += from.output;
  into.cacheCreate += from.cacheCreate;
  into.cacheRead += from.cacheRead;
  return into;
}

export function formatUSD(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
