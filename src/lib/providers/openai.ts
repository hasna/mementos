/**
 * OpenAI provider.
 * Default model: gpt-4.1-nano (ultra cheap, fast).
 * Premium: gpt-4.1-mini, gpt-4.1.
 * Env var: OPENAI_API_KEY.
 */

import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderConfig, ProviderName } from "./base.js";

export const OPENAI_MODELS = {
  default: "gpt-4.1-nano",
  mini: "gpt-4.1-mini",
  full: "gpt-4.1",
} as const;

export class OpenAIProvider extends OpenAICompatProvider {
  readonly name: ProviderName = "openai";
  protected readonly baseUrl = "https://api.openai.com/v1";
  protected readonly authHeader = "Authorization";

  constructor(config?: Partial<ProviderConfig>) {
    super({
      apiKey: config?.apiKey ?? process.env.OPENAI_API_KEY ?? "",
      model: config?.model ?? OPENAI_MODELS.default,
      maxTokens: config?.maxTokens ?? 1024,
      temperature: config?.temperature ?? 0,
      timeoutMs: config?.timeoutMs ?? 15_000,
    });
  }
}
