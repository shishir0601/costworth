/**
 * Per-model token pricing, in USD per 1M tokens.
 * Update this table as providers change their pricing.
 */
const PRICING = {
  "claude-opus": { label: "Claude Opus", input: 15, output: 75 },
  "claude-sonnet": { label: "Claude Sonnet", input: 3, output: 15 },
  "claude-haiku": { label: "Claude Haiku", input: 0.8, output: 4 },
  "gpt-4o": { label: "GPT-4o", input: 2.5, output: 10 },
  "gpt-4o-mini": { label: "GPT-4o mini", input: 0.15, output: 0.6 },
  "gemini-1.5-pro": { label: "Gemini 1.5 Pro", input: 1.25, output: 5 },
  "gemini-1.5-flash": { label: "Gemini 1.5 Flash", input: 0.075, output: 0.3 },
};

/**
 * Blended cost for a request given raw input/output token counts.
 * Throws on an unrecognized model rather than silently returning 0,
 * so a typo'd model id fails loudly instead of under-counting spend.
 */
function costFromTokens(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) throw new Error(`Unknown model: ${model}`);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

module.exports = { PRICING, costFromTokens };
