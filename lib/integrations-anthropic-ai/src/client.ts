import Anthropic from "@anthropic-ai/sdk";

function createClient(): Anthropic {
  // Prefer a user-provided Anthropic API key (hits api.anthropic.com directly).
  if (process.env.ANTHROPIC_API_KEY) {
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  // Fall back to the Replit-managed Anthropic AI integration proxy.
  if (
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY &&
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
  ) {
    return new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }

  throw new Error(
    "No Anthropic credentials found. Set ANTHROPIC_API_KEY to use your own key, or provision the Replit Anthropic AI integration.",
  );
}

export const anthropic = createClient();
