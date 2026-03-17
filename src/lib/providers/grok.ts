/**
 * Grok/xAI provider.
 * OpenAI-compatible API.
 * Default model: grok-3-mini (cheap). Premium: grok-3.
 * Env var: XAI_API_KEY.
 */

import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderConfig, ProviderName } from "./base.js";

export const GROK_MODELS = {
  default: "grok-3-mini",
  premium: "grok-3",
} as const;

export class GrokProvider extends OpenAICompatProvider {
  readonly name: ProviderName = "grok";
  protected readonly baseUrl = "https://api.x.ai/v1";
  protected readonly authHeader = "Authorization";

  constructor(config?: Partial<ProviderConfig>) {
    super({
      apiKey: config?.apiKey ?? process.env.XAI_API_KEY ?? "",
      model: config?.model ?? GROK_MODELS.default,
      maxTokens: config?.maxTokens ?? 1024,
      temperature: config?.temperature ?? 0,
      timeoutMs: config?.timeoutMs ?? 15_000,
    });
  }
}
