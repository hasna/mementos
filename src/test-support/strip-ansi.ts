// A minimal, dependency-free ANSI escape stripper for test assertions against
// CLI output.
//
// WHY THIS EXISTS: `chalk.bold(label)` closes its bold sequence with a reset
// code BEFORE any literal text appended after the call — e.g.
// `` `${chalk.bold("Version")}: ${value}` `` renders as (in escaped form)
// `Version\x1b[22m: 0.14.68`, not `Version: 0.14.68`. A test asserting
// `toContain("Version:")` against that string is testing CONTENT, but colour
// codes emitted between "Version" and ":" are STYLING, and they defeat a
// plain substring match whenever the child process resolves colour on
// (`FORCE_COLOR` set, or a TTY-detecting library defaulting to colour).
//
// `strip-ansi` exists transitively in node_modules (pulled in by an
// unrelated dependency) but is not a direct dependency of this package, so
// importing it would be a phantom-dependency risk: it works today and can
// silently disappear on the next `bun install` if the transitive chain
// changes. This is a few lines of well-known regex — inlining it removes
// that risk entirely.
//
// Pattern matches CSI SGR sequences (ESC '[' <params> 'm') — the only ANSI
// escapes chalk's `.bold()`, `.red()`, `.green()`, `.yellow()` etc. emit.
// Written with the \x1b escape rather than a pasted control character so
// this source file contains only printable bytes.
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/** Remove ANSI/VT100 SGR escape sequences from CLI output before asserting on content. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_SGR_PATTERN, "");
}
