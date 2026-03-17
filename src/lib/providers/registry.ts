/**
 * Provider registry — resolves API keys, manages fallback chain,
 * health checks. Works with zero config (just needs one env var set).
 * Default: Anthropic Haiku → Cerebras → OpenAI.
 */

import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { CerebrasProvider } from "./cerebras.js";
import { GrokProvider } from "./grok.js";
import {
  DEFAULT_AUTO_MEMORY_CONFIG,
  type AutoMemoryConfig,
  type LLMProvider,
  type ProviderName,
} from "./base.js";

// ─── Registry ────────────────────────────────────────────────────────────────

class ProviderRegistry {
  private config: AutoMemoryConfig = { ...DEFAULT_AUTO_MEMORY_CONFIG };
  private _instances = new Map<ProviderName, LLMProvider>();

  /** Update runtime config without restart */
  configure(partial: Partial<AutoMemoryConfig>): void {
    this.config = { ...this.config, ...partial };
    // Clear cached instances so new config takes effect
    this._instances.clear();
  }

  getConfig(): Readonly<AutoMemoryConfig> {
    return this.config;
  }

  /** Get primary provider, or null if no API key available */
  getPrimary(): LLMProvider | null {
    return this.getProvider(this.config.provider);
  }

  /** Get fallback chain — all available providers excluding primary */
  getFallbacks(): LLMProvider[] {
    const fallbackNames = this.config.fallback ?? [];
    return fallbackNames
      .filter((n) => n !== this.config.provider)
      .map((n) => this.getProvider(n))
      .filter((p): p is LLMProvider => p !== null);
  }

  /**
   * Get the best available provider.
   * Returns primary if available, otherwise first available fallback.
   * Returns null only if no providers have API keys configured.
   */
  getAvailable(): LLMProvider | null {
    const primary = this.getPrimary();
    if (primary) return primary;
    const fallbacks = this.getFallbacks();
    return fallbacks[0] ?? null;
  }

  /**
   * Get a specific provider by name.
   * Returns null if no API key is configured for that provider.
   */
  getProvider(name: ProviderName): LLMProvider | null {
    const cached = this._instances.get(name);
    if (cached) return cached;

    const provider = this.createProvider(name);
    if (!provider) return null;

    // Only cache if it has an API key
    if (!provider.config.apiKey) return null;

    this._instances.set(name, provider);
    return provider;
  }

  /** Check which providers have API keys configured */
  health(): Record<ProviderName, { available: boolean; model: string }> {
    const providers: ProviderName[] = ["anthropic", "openai", "cerebras", "grok"];
    const result = {} as Record<ProviderName, { available: boolean; model: string }>;
    for (const name of providers) {
      const p = this.createProvider(name);
      result[name] = {
        available: Boolean(p?.config.apiKey),
        model: p?.config.model ?? "unknown",
      };
    }
    return result;
  }

  private createProvider(name: ProviderName): LLMProvider | null {
    const modelOverride =
      name === this.config.provider ? this.config.model : undefined;

    switch (name) {
      case "anthropic":
        return new AnthropicProvider(modelOverride ? { model: modelOverride } : undefined);
      case "openai":
        return new OpenAIProvider(modelOverride ? { model: modelOverride } : undefined);
      case "cerebras":
        return new CerebrasProvider(modelOverride ? { model: modelOverride } : undefined);
      case "grok":
        return new GrokProvider(modelOverride ? { model: modelOverride } : undefined);
      default:
        return null;
    }
  }
}

/** Singleton registry — shared across the whole process */
export const providerRegistry = new ProviderRegistry();

// ─── Auto-configure from environment on load ─────────────────────────────────

// Auto-detect available providers from env vars and set a sensible default
function autoConfigureFromEnv(): void {
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasCerebrasKey = Boolean(process.env.CEREBRAS_API_KEY);
  const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
  const hasGrokKey = Boolean(process.env.XAI_API_KEY);

  // If no Anthropic key, pick the first available as primary
  if (!hasAnthropicKey) {
    if (hasCerebrasKey) {
      providerRegistry.configure({ provider: "cerebras" });
    } else if (hasOpenAIKey) {
      providerRegistry.configure({ provider: "openai" });
    } else if (hasGrokKey) {
      providerRegistry.configure({ provider: "grok" });
    }
    // If none available, keep default — getAvailable() returns null cleanly
  }

  // Build fallback chain from whatever is available (excluding primary)
  const allProviders: ProviderName[] = ["anthropic", "cerebras", "openai", "grok"];
  const available = allProviders.filter((p) => {
    switch (p) {
      case "anthropic": return hasAnthropicKey;
      case "cerebras": return hasCerebrasKey;
      case "openai": return hasOpenAIKey;
      case "grok": return hasGrokKey;
    }
  });

  const primary = providerRegistry.getConfig().provider;
  const fallback = available.filter((p) => p !== primary);
  providerRegistry.configure({ fallback });
}

autoConfigureFromEnv();
