/**
 * Shared base for all OpenAI-compatible providers.
 * Used by: OpenAI, Cerebras, Grok/xAI.
 * Handles: API calls, exponential backoff on 429, shared JSON parsing.
 */

import {
  BaseProvider,
  type ProviderConfig,
  type MemoryExtractionContext,
  type ExtractedMemory,
  type EntityExtractionResult,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  MEMORY_EXTRACTION_USER_TEMPLATE,
  ENTITY_EXTRACTION_SYSTEM_PROMPT,
  ENTITY_EXTRACTION_USER_TEMPLATE,
} from "./base.js";

export abstract class OpenAICompatProvider extends BaseProvider {
  protected abstract readonly baseUrl: string;
  protected abstract readonly authHeader: string;

  constructor(config: ProviderConfig) {
    super(config);
  }

  async extractMemories(
    text: string,
    context: MemoryExtractionContext
  ): Promise<ExtractedMemory[]> {
    if (!this.config.apiKey) return [];
    try {
      const response = await this.callWithRetry(
        MEMORY_EXTRACTION_SYSTEM_PROMPT,
        MEMORY_EXTRACTION_USER_TEMPLATE(text, context)
      );
      const parsed = this.parseJSON<unknown[]>(response);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => this.normaliseMemory(item))
        .filter((m): m is ExtractedMemory => m !== null);
    } catch (err) {
      console.error(`[${this.name}] extractMemories failed:`, err);
      return [];
    }
  }

  async extractEntities(text: string): Promise<EntityExtractionResult> {
    const empty: EntityExtractionResult = { entities: [], relations: [] };
    if (!this.config.apiKey) return empty;
    try {
      const response = await this.callWithRetry(
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
      console.error(`[${this.name}] extractEntities failed:`, err);
      return empty;
    }
  }

  async scoreImportance(
    content: string,
    _context: MemoryExtractionContext
  ): Promise<number> {
    if (!this.config.apiKey) return 5;
    try {
      const response = await this.callWithRetry(
        "You are an importance scorer. Return only a single integer 0-10. No explanation.",
        `How important is this memory for an AI agent to retain long-term?\n\n"${content}"\n\nReturn only a number 0-10.`
      );
      return this.clampImportance(response.trim());
    } catch {
      return 5;
    }
  }

  /** Call with exponential backoff on 429 (rate limit), max 3 retries */
  private async callWithRetry(
    systemPrompt: string,
    userMessage: string,
    retries = 3
  ): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await this.callAPI(systemPrompt, userMessage);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isRateLimit =
          lastError.message.includes("429") ||
          lastError.message.toLowerCase().includes("rate limit");
        if (!isRateLimit || attempt === retries - 1) throw lastError;
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
    throw lastError ?? new Error("Unknown error");
  }

  private async callAPI(
    systemPrompt: string,
    userMessage: string
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 15_000
    );

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [this.authHeader]: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 1024,
          temperature: this.config.temperature ?? 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${this.name} API ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }
}
