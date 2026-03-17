/**
 * Anthropic provider (DEFAULT).
 * Default model: claude-haiku-4-5 — cheap, fast, good quality.
 * Premium option: claude-sonnet-4-5.
 * Never throws — returns [] / empty results on failure.
 */

import {
  BaseProvider,
  type ProviderConfig,
  type ProviderName,
  type MemoryExtractionContext,
  type ExtractedMemory,
  type EntityExtractionResult,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  MEMORY_EXTRACTION_USER_TEMPLATE,
  ENTITY_EXTRACTION_SYSTEM_PROMPT,
  ENTITY_EXTRACTION_USER_TEMPLATE,
} from "./base.js";

export const ANTHROPIC_MODELS = {
  default: "claude-haiku-4-5",
  premium: "claude-sonnet-4-5",
} as const;

export class AnthropicProvider extends BaseProvider {
  readonly name: ProviderName = "anthropic";
  private readonly baseUrl = "https://api.anthropic.com/v1";

  constructor(config?: Partial<ProviderConfig>) {
    const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    super({
      apiKey,
      model: config?.model ?? ANTHROPIC_MODELS.default,
      maxTokens: config?.maxTokens ?? 1024,
      temperature: config?.temperature ?? 0,
      timeoutMs: config?.timeoutMs ?? 15_000,
    });
  }

  async extractMemories(
    text: string,
    context: MemoryExtractionContext
  ): Promise<ExtractedMemory[]> {
    if (!this.config.apiKey) return [];
    try {
      const response = await this.callAPI(
        MEMORY_EXTRACTION_SYSTEM_PROMPT,
        MEMORY_EXTRACTION_USER_TEMPLATE(text, context)
      );
      const parsed = this.parseJSON<unknown[]>(response);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => this.normaliseMemory(item))
        .filter((m): m is ExtractedMemory => m !== null);
    } catch (err) {
      console.error("[anthropic] extractMemories failed:", err);
      return [];
    }
  }

  async extractEntities(text: string): Promise<EntityExtractionResult> {
    const empty: EntityExtractionResult = { entities: [], relations: [] };
    if (!this.config.apiKey) return empty;
    try {
      const response = await this.callAPI(
        ENTITY_EXTRACTION_SYSTEM_PROMPT,
        ENTITY_EXTRACTION_USER_TEMPLATE(text)
      );
      const parsed = this.parseJSON<EntityExtractionResult>(response);
      if (!parsed || typeof parsed !== "object") return empty;
      return {
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      };
    } catch (err) {
      console.error("[anthropic] extractEntities failed:", err);
      return empty;
    }
  }

  async scoreImportance(
    content: string,
    _context: MemoryExtractionContext
  ): Promise<number> {
    if (!this.config.apiKey) return 5;
    try {
      const response = await this.callAPI(
        "You are an importance scorer. Return only a single integer 0-10. No explanation.",
        `How important is this memory for an AI agent to retain long-term?\n\n"${content}"\n\nReturn only a number 0-10.`
      );
      return this.clampImportance(response.trim());
    } catch {
      return 5;
    }
  }

  private async callAPI(systemPrompt: string, userMessage: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 15_000
    );

    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 1024,
          temperature: this.config.temperature ?? 0,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text: string }>;
      };
      return data.content?.[0]?.text ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }
}
