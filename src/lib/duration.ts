/**
 * Human-readable duration parsing and formatting.
 *
 * Supported formats:
 *   Ns  — seconds
 *   Nm  — minutes
 *   Nh  — hours
 *   Nd  — days
 *   Nw  — weeks
 *   Combinations: 1d12h, 2h30m
 *   Plain numbers: treated as milliseconds (backwards compat)
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_RE = /^(\d+[smhdw])+$/;
const SEGMENT_RE = /(\d+)([smhdw])/g;

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * @param input - Duration string (e.g. "1d12h", "30m", "500") or numeric ms
 * @returns milliseconds
 * @throws Error on invalid format
 */
export function parseDuration(input: string | number): number {
  // Numeric input — treat as milliseconds (backwards compat)
  if (typeof input === "number") return input;

  const trimmed = input.trim();
  if (trimmed === "") throw new Error("Invalid duration: empty string");

  // Plain numeric string — treat as milliseconds
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  if (!DURATION_RE.test(trimmed)) {
    throw new Error(
      `Invalid duration format: "${trimmed}". Use combinations of Ns, Nm, Nh, Nd, Nw (e.g. "1d12h", "30m") or plain milliseconds.`
    );
  }

  let total = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex since we reuse the regex
  SEGMENT_RE.lastIndex = 0;
  while ((match = SEGMENT_RE.exec(trimmed)) !== null) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    total += value * UNIT_MS[unit]!;
  }

  if (total === 0) {
    throw new Error(`Invalid duration: "${trimmed}" resolves to 0ms`);
  }

  return total;
}

// Units ordered largest-first for formatting
const FORMAT_UNITS: [string, number][] = [
  ["w", UNIT_MS["w"]!],
  ["d", UNIT_MS["d"]!],
  ["h", UNIT_MS["h"]!],
  ["m", UNIT_MS["m"]!],
  ["s", UNIT_MS["s"]!],
];

/**
 * Format milliseconds into a human-readable duration string.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable string (e.g. "1d12h", "30m", "500ms")
 */
export function formatDuration(ms: number): string {
  if (ms < 0) throw new Error("Duration cannot be negative");
  if (ms === 0) return "0s";

  // Sub-second — show raw ms
  if (ms < 1000) return `${ms}ms`;

  const parts: string[] = [];
  let remaining = ms;

  for (const [unit, unitMs] of FORMAT_UNITS) {
    if (remaining >= unitMs) {
      const count = Math.floor(remaining / unitMs);
      parts.push(`${count}${unit}`);
      remaining -= count * unitMs;
    }
  }

  // If there's a leftover sub-second remainder, drop it (round down to nearest second)
  return parts.join("");
}
