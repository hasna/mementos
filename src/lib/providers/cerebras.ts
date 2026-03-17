/**
 * Cerebras provider — ultra-fast inference (~2000 tok/sec).
 * OpenAI-compatible API.
 * Default model: llama-3.3-70b.
 * Ideal for real-time non-blocking extraction.
 * Env var: CEREBRAS_API_KEY.
 */

import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderConfig, ProviderName } from "./base.js";

export const CEREBRAS_MODELS = {
  default: "llama-3.3-70b",
  fast: "llama3.1-8b",
} as const;

export class CerebrasProvider extends OpenAICompatProvider {
  readonly name: ProviderName = "cerebras";
  protected readonly baseUrl = "https://api.cerebras.ai/v1";
  protected readonly authHeader = "Authorization";

  constructor(config?: Partial<ProviderConfig>) {
    super({
      apiKey: config?.apiKey ?? process.env.CEREBRAS_API_KEY ?? "",
      model: config?.model ?? CEREBRAS_MODELS.default,
      maxTokens: config?.maxTokens ?? 1024,
      temperature: config?.temperature ?? 0,
      timeoutMs: config?.timeoutMs ?? 10_000, // Cerebras is fast — shorter timeout
    });
  }
}
