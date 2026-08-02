// Exit-status contract for `mementos recall` / `mementos get`.
//
// Kept in its own module, free of any import, so tests and callers can assert
// against the contract without pulling the command's database dependencies into
// their own process. (This suite drives the CLI as a subprocess precisely so the
// test process never opens a store — see src/test-support/store-isolation.ts.)
//
//   0 — the requested key was found, exactly.
//   1 — nothing was returned at all.
//   2 — a DIFFERENT record was substituted for the requested key (`--fuzzy`).
//
// 2 is distinct from 1 so that a shell `if` treats both as failure — which is
// what an existence check wants — while a caller that cares can still tell
// "here is a neighbour" from "there is nothing".

export const RECALL_EXIT_NOT_FOUND = 1;
export const RECALL_EXIT_FUZZY = 2;
