/** Integer nano-USD (1e-9 USD) keeps cap checks off binary float dust. */

export function usdToNano(usd: number): number {
  return Math.round(usd * 1_000_000_000);
}

/** `usdPerMillion` is the published USD / 1,000,000 tokens rate. */
export function tokensToNano(tokens: number, usdPerMillion: number): number {
  return Math.round(tokens * usdPerMillion * 1000);
}

export function formatUsd(nano: number): string {
  const usd = nano / 1_000_000_000;
  const abs = Math.abs(usd);
  const digits = abs > 0 && abs < 0.01 ? 6 : 4;
  const sign = usd < 0 ? "-" : "";
  return `${sign}$${Math.abs(usd).toFixed(digits)}`;
}

export function formatTokens(tokens: number): string {
  return Math.round(tokens).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return "over cap";
  return `${Math.round(ratio * 100)}%`;
}

export function billedTokens(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens
  );
}
