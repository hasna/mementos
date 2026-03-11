import { describe, it, expect } from "bun:test";
import { redactSecrets, containsSecrets } from "./redact.js";

const REDACTED = "[REDACTED]";

// ============================================================================
// redactSecrets
// ============================================================================

describe("redactSecrets", () => {
  // --- OpenAI keys ---
  it("redacts OpenAI API key", () => {
    const input = "my key is sk-abc123def456ghi789jk";
    expect(redactSecrets(input)).toBe(`my key is ${REDACTED}`);
  });

  it("redacts OpenAI key with longer suffix", () => {
    const input = "sk-proj-abcdefghij1234567890extra";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  // --- Anthropic keys ---
  it("redacts Anthropic API key", () => {
    const input = "key: sk-ant-abc123def456ghi789jk";
    expect(redactSecrets(input)).toBe(`key: ${REDACTED}`);
  });

  // --- Generic key patterns ---
  it("redacts pk_test_ prefixed keys", () => {
    const input = "pk_test_abcdefghijklmnop";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  it("redacts tok- prefixed tokens", () => {
    const input = "tok-abcdefghij1234567890";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  it("redacts api_key- prefixed keys", () => {
    const input = "api_key-abcdefghij1234567890";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  it("redacts api-key prefixed keys (case insensitive)", () => {
    const input = "API-KEY_abcdefghij1234567890";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  // --- AWS access keys ---
  it("redacts AWS access key ID", () => {
    const input = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(input)).toBe(`aws_access_key_id = ${REDACTED}`);
  });

  // --- GitHub tokens ---
  it("redacts GitHub personal access token (ghp_)", () => {
    const token = "ghp_" + "a".repeat(36);
    const input = `token: ${token}`;
    expect(redactSecrets(input)).toBe(`token: ${REDACTED}`);
  });

  it("redacts GitHub OAuth token (gho_)", () => {
    const token = "gho_" + "b".repeat(36);
    const input = `auth: ${token}`;
    expect(redactSecrets(input)).toBe(`auth: ${REDACTED}`);
  });

  it("redacts GitHub server token (ghs_)", () => {
    const token = "ghs_" + "c".repeat(36);
    expect(redactSecrets(token)).toBe(REDACTED);
  });

  // --- npm tokens ---
  it("redacts npm tokens", () => {
    const token = "npm_" + "d".repeat(36);
    expect(redactSecrets(`npm token: ${token}`)).toBe(`npm token: ${REDACTED}`);
  });

  // --- Bearer tokens ---
  it("redacts Bearer tokens in headers", () => {
    const input = "Authorization: Bearer eyABCDEFGHIJKLMNOPQRSTU";
    expect(redactSecrets(input)).toBe(`Authorization: ${REDACTED}`);
  });

  // --- Connection strings ---
  it("redacts postgres connection string", () => {
    const input = "DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/mydb";
    expect(redactSecrets(input)).toBe(`DATABASE_URL=${REDACTED}`);
  });

  it("redacts redis connection string", () => {
    const input = "REDIS_URL=redis://user:pass@redis.host:6379/0";
    expect(redactSecrets(input)).toBe(`REDIS_URL=${REDACTED}`);
  });

  it("redacts mongodb connection string", () => {
    const input = "mongodb://root:password123@mongo.host:27017/admin";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  // --- Stripe keys ---
  it("redacts Stripe secret key (sk_test_)", () => {
    const key = "sk_test_" + "e".repeat(24);
    expect(redactSecrets(`stripe: ${key}`)).toBe(`stripe: ${REDACTED}`);
  });

  it("redacts Stripe publishable key (pk_live_)", () => {
    const key = "pk_live_" + "f".repeat(24);
    expect(redactSecrets(key)).toBe(REDACTED);
  });

  // --- Slack tokens ---
  it("redacts Slack bot tokens (xoxb-)", () => {
    const token = "xoxb-" + "g".repeat(24);
    expect(redactSecrets(`slack: ${token}`)).toBe(`slack: ${REDACTED}`);
  });

  // --- JWT tokens ---
  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi";
    const input = `token: ${jwt}`;
    expect(redactSecrets(input)).toBe(`token: ${REDACTED}`);
  });

  // --- .env secrets ---
  it("redacts SECRET_KEY=value pattern", () => {
    const input = 'SECRET_KEY="my-super-secret-value"';
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  it("redacts API_TOKEN=value pattern", () => {
    const input = "API_TOKEN=abcdefghijklmnop1234";
    expect(redactSecrets(input)).toContain(REDACTED);
    expect(redactSecrets(input)).not.toContain("abcdefghijklmnop1234");
  });

  it("redacts PASSWORD=value pattern", () => {
    const input = "DATABASE_PASSWORD=hunter2hunter2";
    expect(redactSecrets(input)).toContain(REDACTED);
    expect(redactSecrets(input)).not.toContain("hunter2hunter2");
  });

  it("redacts AUTH_CREDENTIAL pattern", () => {
    const input = "AUTH_CREDENTIAL=someLongSecretValue99";
    expect(redactSecrets(input)).toBe(REDACTED);
  });

  // --- Non-secrets preserved ---
  it("preserves normal text", () => {
    const input = "This is a normal sentence about programming.";
    expect(redactSecrets(input)).toBe(input);
  });

  it("preserves URLs without credentials", () => {
    const input = "Visit https://example.com/api/v1/docs for more info.";
    expect(redactSecrets(input)).toBe(input);
  });

  it("preserves short strings", () => {
    const input = "sk-short";
    expect(redactSecrets(input)).toBe(input);
  });

  it("preserves normal variable assignments", () => {
    const input = "PORT=3000";
    expect(redactSecrets(input)).toBe(input);
  });

  // --- Multiple secrets ---
  it("redacts multiple secrets in one string", () => {
    const openai = "sk-abc123def456ghi789jk";
    const ghToken = "ghp_" + "x".repeat(36);
    const input = `Keys: ${openai} and ${ghToken} are secret`;
    const result = redactSecrets(input);
    expect(result).toBe(`Keys: ${REDACTED} and ${REDACTED} are secret`);
    expect(result).not.toContain("sk-abc");
    expect(result).not.toContain("ghp_");
  });

  // --- Empty string ---
  it("handles empty string", () => {
    expect(redactSecrets("")).toBe("");
  });

  // --- Idempotent ---
  it("is idempotent on already-redacted text", () => {
    const input = `key: ${REDACTED}`;
    expect(redactSecrets(input)).toBe(input);
  });
});

// ============================================================================
// containsSecrets
// ============================================================================

describe("containsSecrets", () => {
  it("returns true for OpenAI key", () => {
    expect(containsSecrets("sk-abc123def456ghi789jk")).toBe(true);
  });

  it("returns true for Anthropic key", () => {
    expect(containsSecrets("sk-ant-abc123def456ghi789jk")).toBe(true);
  });

  it("returns true for AWS access key", () => {
    expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("returns true for GitHub token", () => {
    expect(containsSecrets("ghp_" + "a".repeat(36))).toBe(true);
  });

  it("returns true for JWT", () => {
    expect(
      containsSecrets(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi"
      )
    ).toBe(true);
  });

  it("returns true for connection string", () => {
    expect(containsSecrets("postgres://user:pass@host:5432/db")).toBe(true);
  });

  it("returns true for Stripe key", () => {
    expect(containsSecrets("sk_test_" + "z".repeat(24))).toBe(true);
  });

  it("returns true for Bearer token", () => {
    expect(containsSecrets("Bearer eyABCDEFGHIJKLMNOPQRSTU")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(containsSecrets("Hello world, this is fine.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsSecrets("")).toBe(false);
  });

  it("returns false for short key-like string", () => {
    expect(containsSecrets("sk-short")).toBe(false);
  });

  it("returns true for .env secret pattern", () => {
    expect(containsSecrets("SECRET_KEY=super-secret-value-here")).toBe(true);
  });
});
