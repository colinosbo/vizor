// Standard text-token list prices in USD / million tokens. No prompt caching is requested.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
export const PRICING_DATE = "2026-10-27";
const prices: Record<string, [number, number]> = {
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
};
export function modelPrice(
  provider: string,
  model: string,
): [number, number] | undefined {
  return provider === "openai"
    ? (
        { "gpt-4.1-mini": [0.4, 1.6], "gpt-4.1": [2, 8] } as Record<
          string,
          [number, number]
        >
      )[model]
    : provider === "anthropic"
      ? prices[model]
      : undefined;
}
export function estimateCost(
  model: string,
  input: number | null,
  output: number | null,
  provider = "anthropic",
) {
  const rate = modelPrice(provider, model);
  return rate && input !== null && output !== null
    ? (input * rate[0] + output * rate[1]) / 1_000_000
    : null;
}
