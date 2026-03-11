// ============================================================================
// Secret redaction — auto-detect and replace secrets before storing memories
// ============================================================================

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  // OpenAI API keys
  { name: "openai_key", pattern: /sk-[a-zA-Z0-9_-]{20,}/g },
  // Anthropic API keys
  { name: "anthropic_key", pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  // Generic API key prefixes
  { name: "generic_key", pattern: /(?:pk|tok|key|token|api[_-]?key)[_-][a-zA-Z0-9_-]{16,}/gi },
  // AWS access keys
  { name: "aws_key", pattern: /AKIA[A-Z0-9]{16}/g },
  // AWS secret keys (40-char base64)
  { name: "aws_secret", pattern: /(?<=AWS_SECRET_ACCESS_KEY\s*=\s*)[A-Za-z0-9/+=]{40}/g },
  // GitHub tokens
  { name: "github_token", pattern: /gh[ps]_[a-zA-Z0-9]{36,}/g },
  { name: "github_oauth", pattern: /gho_[a-zA-Z0-9]{36,}/g },
  // npm tokens
  { name: "npm_token", pattern: /npm_[a-zA-Z0-9]{36,}/g },
  // Bearer tokens in headers
  { name: "bearer", pattern: /Bearer\s+[a-zA-Z0-9_\-.]{20,}/g },
  // Connection strings with credentials
  { name: "conn_string", pattern: /(?:postgres|postgresql|mysql|mongodb|redis|amqp|mqtt):\/\/[^\s"'`]+@[^\s"'`]+/gi },
  // .env style secrets (KEY=value where KEY contains SECRET, TOKEN, PASSWORD, API_KEY, etc.)
  { name: "env_secret", pattern: /(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL)[_A-Z]*\s*=\s*["']?[^\s"'\n]{8,}["']?/gi },
  // Stripe keys
  { name: "stripe_key", pattern: /(?:sk|pk|rk)_(?:test|live)_[a-zA-Z0-9]{20,}/g },
  // Slack tokens
  { name: "slack_token", pattern: /xox[bpras]-[a-zA-Z0-9-]{20,}/g },
  // JWT tokens (3 base64 parts separated by dots)
  { name: "jwt", pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
  // Hex-encoded secrets (32+ chars that look like hashes/tokens)
  { name: "hex_secret", pattern: /(?<=(?:key|token|secret|password|hash)\s*[:=]\s*["']?)[0-9a-f]{32,}(?=["']?)/gi },
];

/**
 * Detect and redact secrets from text.
 * Returns the text with secrets replaced by [REDACTED].
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Check if text contains any detectable secrets.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
