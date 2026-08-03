import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { isApiMode } from "../../db/api-mode.js";
import {
  createMemory,
  getMemory,
  getMemoriesByKey,
  updateMemory,
  deleteMemory,
} from "../../db/memories.js";
import { getProject } from "../../db/projects.js";
import { getAgent } from "../../db/agents.js";
import { parseDuration } from "../../lib/duration.js";
import { validateEnumField, formatEnumViolation } from "../../lib/enum-validation.js";
import { MEMORY_CATEGORIES, MEMORY_SCOPES } from "../../types/index.js";
import type {
  MemoryCategory,
  MemoryScope,
  MemoryStatus,
  MemorySource,
  CreateMemoryInput,
} from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  resolveMemoryId,
  type GlobalOpts,
} from "../helpers.js";

export function registerCrudCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // save <key> <value>
  // ============================================================================

  program
    .command("save <key> <value>")
    .description("Save a memory (create or upsert)")
    .option("-c, --category <cat>", `Category: ${MEMORY_CATEGORIES.join(", ")}`)
    .option("--scope <scope>", `Scope: ${MEMORY_SCOPES.join(", ")}`)
    .option("--importance <n>", "Importance 1-10", parseInt)
    .option("--tags <tags>", "Comma-separated tags")
    .option("--summary <text>", "Brief summary")
    .option("--ttl <duration>", "Time-to-live: 30s, 5m, 2h, 1d, 1w, or milliseconds")
    .option("--source <src>", "Source: user, agent, system, auto, imported")
    .option(
      "--template <name>",
      "Apply a template: correction, preference, decision, learning"
    )
    .option(
      "--dedupe <mode>",
      "Conflict handling: merge (default, upsert the matching row), create (fork a new row under the same key), error"
    )
    .action((key: string, value: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();

        // Template defaults — explicit flags override template values
        const templates: Record<
          string,
          {
            scope: MemoryScope;
            category: MemoryCategory;
            importance: number;
            tags: string[];
          }
        > = {
          correction: {
            scope: "shared",
            category: "knowledge",
            importance: 9,
            tags: ["correction"],
          },
          preference: {
            scope: "global",
            category: "preference",
            importance: 8,
            tags: [],
          },
          decision: {
            scope: "shared",
            category: "fact",
            importance: 8,
            tags: ["decision"],
          },
          learning: {
            scope: "shared",
            category: "knowledge",
            importance: 7,
            tags: ["learning"],
          },
        };

        let templateDefaults:
          | {
              scope: MemoryScope;
              category: MemoryCategory;
              importance: number;
              tags: string[];
            }
          | undefined;
        if (opts.template) {
          const tpl = templates[opts.template as string];
          if (!tpl) {
            console.error(
              chalk.red(
                `Unknown template: ${opts.template}. Valid templates: ${Object.keys(templates).join(", ")}`
              )
            );
            process.exit(1);
          }
          templateDefaults = tpl;
        }

        // Reject out-of-enum values before spending a network round trip. These
        // used to travel to the server and come back as an opaque 500.
        for (const [flag, value] of [
          ["category", opts.category],
          ["scope", opts.scope],
          ["source", opts.source],
        ] as const) {
          const violation = validateEnumField(flag, value);
          if (!violation) continue;
          let msg = formatEnumViolation(violation);
          // The most common miss: `--category decision` when `--template
          // decision` was meant (a template, not a category).
          if (flag === "category" && templates[violation.value]) {
            msg += ` Did you mean --template ${violation.value}?`;
          }
          // Throw rather than console.error + exit: handleError is the single
          // error channel and is the only thing that honours --json/--format
          // json. Printing here would emit colour to stderr and leave stdout
          // empty, breaking `mementos --json save … | jq -r .error` for exactly
          // the input this validation exists to catch.
          throw new Error(msg);
        }

        const explicitTags = opts.tags
          ? (opts.tags as string).split(",").map((t: string) => t.trim())
          : undefined;

        // Merge: explicit flags > template defaults > undefined
        const mergedTags = explicitTags
          ? explicitTags
          : templateDefaults?.tags && templateDefaults.tags.length > 0
            ? templateDefaults.tags
            : undefined;

        // Resolve agent name/partial-id → actual agent ID (avoids FK violation).
        //
        // An unresolvable name is REFUSED rather than dropped. Dropping it left
        // `agent_id` undefined, and the upsert bucket collapses "undefined" and
        // "no --agent at all" onto the same value — `?? ""` in the fork guard
        // below, `COALESCE(agent_id,'')` in createMemory. So `--agent <typo>`
        // silently retargeted the write onto the UNOWNED row for this key and
        // upserted it, reporting rc=0 "Updated".
        //
        // Two things made that worth a throw rather than a warning:
        //   1. It is destructive. Measured on the fleet store 2026-08-03, 812 of
        //      1169 active rows (69.5%) carry a NULL agent_id, so the unowned
        //      bucket is the majority of the store, not an empty corner.
        //   2. It is not recoverable afterwards. `agent_id` and
        //      `created_by_agent` are both NULL whether the caller passed a bogus
        //      agent or passed none, so an overwritten row is indistinguishable
        //      from a legitimately unowned one.
        //
        // The sibling `--session` guard added in #42 only WARNS, and that remains
        // right for it: `--session shared` writes a legal row and is a
        // documentation bug, whereas this writes to a bucket the caller did not
        // name and destroys what was there. The blast radius was measured before
        // choosing: across four skill homes there are 74 `mementos save` call
        // sites and ZERO of them pass `--agent` or `--project`.
        //
        // A row owned by a REAL other agent was never at risk here — its bucket
        // differs, so the fork guard below already refused it.
        let resolvedAgentId: string | undefined;
        if (globalOpts.agent) {
          const ag = getAgent(globalOpts.agent);
          if (!ag) {
            throw new Error(
              `Unknown agent "${globalOpts.agent}": no registered agent matches that name or id.\n` +
                `Refusing to save. Dropping the flag would write this memory to the unowned ` +
                `(no-agent) row for key "${key}", overwriting whatever is there under an owner ` +
                `you did not name.\n` +
                `Register the agent first:  mementos register-agent ${globalOpts.agent}\n` +
                `Or omit --agent to write to the unowned row deliberately.`,
            );
          }
          resolvedAgentId = ag.id;
        }

        const input: CreateMemoryInput = {
          key,
          value,
          category:
            (opts.category as MemoryCategory | undefined) ??
            templateDefaults?.category,
          scope:
            (opts.scope as MemoryScope | undefined) ?? templateDefaults?.scope,
          importance:
            (opts.importance as number | undefined) ??
            templateDefaults?.importance,
          tags: mergedTags,
          summary: opts.summary as string | undefined,
          ttl_ms: opts.ttl ? parseDuration(opts.ttl) : undefined,
          source: opts.source as MemorySource | undefined,
          agent_id: resolvedAgentId,
          session_id: globalOpts.session,
        };

        // Resolve project from --project path. Refused when unresolvable, for
        // exactly the reason given for --agent above: project_id is another
        // column of the same upsert bucket, so a path that is not a registered
        // project silently retargeted the write onto the no-project row and
        // upserted it. Same defect, same function, same consequence — fixing one
        // and leaving the other would be fixing the instance instead of the
        // mechanism.
        if (globalOpts.project) {
          const projectPath = resolve(globalOpts.project);
          const project = getProject(projectPath);
          if (!project) {
            throw new Error(
              `Unknown project "${projectPath}": no registered project matches that path.\n` +
                `Refusing to save. Dropping the flag would write this memory to the no-project ` +
                `row for key "${key}", overwriting whatever is there in a scope you did not name.\n` +
                `Register it first:  mementos projects --add --path ${projectPath} --name <name>\n` +
                `Or omit --project to write outside any project deliberately.`,
            );
          }
          input.project_id = project.id;
        }

        // HC-00149's other half. `update` already refuses a no-op and points at
        // the shadowed short flag; `save` never did, so `save k v -s shared`
        // stayed silently wrong — it writes session_id="shared" and leaves scope
        // at its default, which is the opposite of what the author asked for.
        //
        // Measured on the live fleet store 2026-08-03: 96 of 1142 active rows
        // carry a session_id that is literally a scope word (87 "shared", 7
        // "private", 2 "global"). Nobody has ever named a session "shared".
        //
        // Warn rather than throw: the write itself is legal, `--session shared`
        // is not forgeable as an error, and 80 skill-file call sites across six
        // skill homes currently depend on it succeeding. Failing here would
        // convert a documentation bug into a fleet outage. Advice on stderr
        // keeps stdout clean for `--json` consumers.
        if (
          typeof input.session_id === "string" &&
          (MEMORY_SCOPES as readonly string[]).includes(input.session_id)
        ) {
          console.error(
            chalk.yellow(
              `Warning: --session "${input.session_id}" looks like a scope, not a session id. ` +
                `Note that -s is the global --session, not --scope; this save is writing ` +
                `session_id="${input.session_id}" and leaving scope at "${input.scope ?? "private"}". ` +
                `If you meant the scope, pass --scope ${input.session_id} (long form only).`,
            ),
          );
        }

        // `save` is documented as "create or upsert", but the upsert matches on
        // the FIVE-column tuple (key, scope, agent_id, project_id, session_id)
        // — see createMemory's merge branch in src/db/memories.ts. So the same
        // key saved with a different scope or project silently became a SECOND
        // active row, and a later reader searching that key got two answers with
        // no signal about which was current.
        //
        // Refuse that fork unless it is asked for explicitly. Only ACTIVE rows
        // count (getMemoriesByKey filters status='active'), so an archived
        // predecessor never blocks a save.
        const bucket = (m: { scope?: string | null; agent_id?: string | null; project_id?: string | null; session_id?: string | null }) =>
          [m.scope ?? "private", m.agent_id ?? "", m.project_id ?? "", m.session_id ?? ""].join("\u001f");
        const targetBucket = bucket({
          scope: input.scope ?? "private",
          agent_id: input.agent_id,
          project_id: input.project_id,
          session_id: input.session_id,
        });

        const dedupe = opts.dedupe as string | undefined;
        // "create"/"version-fork" mean "fork on purpose" — that is the override.
        const forkRequested = dedupe === "create" || dedupe === "version-fork";
        let willUpdateExisting = false;
        if (!forkRequested) {
          const sameKey = getMemoriesByKey(key);
          const match = sameKey.find((m) => bucket(m) === targetBucket);
          willUpdateExisting = Boolean(match);
          if (!match && sameKey.length > 0) {
            const rows = sameKey
              .map((m) => `  ${m.id.slice(0, 8)}  scope=${m.scope}  project=${m.project_id ?? "none"}  session=${m.session_id ?? "none"}  agent=${m.agent_id ?? "none"}`)
              .join("\n");
            // The bucket is FOUR columns (scope, agent, project, session) but
            // this descriptor listed three, omitting agent. When agent is the
            // only column that differs — two agents saving one key, which is
            // the common fleet case — the target line and the existing-row line
            // printed identical scope/project/session and the refusal read as
            // self-contradictory. Name every column that is actually compared.
            throw new Error(
              `Refusing to fork key "${key}": ${sameKey.length} active memor${sameKey.length === 1 ? "y" : "ies"} ` +
                `already ${sameKey.length === 1 ? "uses" : "use"} it, ` +
                `but none matches the scope/project/session/agent this save targets ` +
                `(scope=${input.scope ?? "private"}, project=${input.project_id ?? "none"}, session=${input.session_id ?? "none"}, agent=${input.agent_id ?? "none"}).\n` +
                `${rows}\n` +
                `Saving would create a second active row under the same key. Either target the existing row ` +
                `(match its scope/project/session/agent flags, or use \`mementos update <id>\`), or pass \`--dedupe create\` ` +
                `to fork deliberately.`,
            );
          }
        }

        const memory = forkRequested
          ? createMemory(input, dedupe as import("../../types/index.js").DedupeMode)
          : createMemory(input);

        // "Saved" was identical for a create and for an upsert, so a silent fork
        // was indistinguishable from an update. Say which one happened.
        const outcome = willUpdateExisting ? "Updated" : "Created";
        if (globalOpts.json) {
          outputJson({ ...memory, outcome: outcome.toLowerCase() });
        } else {
          console.log(chalk.green(`${outcome}: ${memory.key} (${memory.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // update <id>
  // ============================================================================

  program
    .command("update <id>")
    .description("Update a memory by ID")
    .option("--value <text>", "New value")
    .option("--importance <n>", "New importance 1-10", parseInt)
    .option("--tags <tags>", "New comma-separated tags")
    .option("--summary <text>", "New summary")
    .option("--pin", "Pin the memory")
    .option("--unpin", "Unpin the memory")
    .option("-c, --category <cat>", "New category")
    .option("--scope <scope>", "New scope")
    .option("--status <status>", "New status: active, archived, expired")
    .action((id: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const resolvedId = resolveMemoryId(id);
        const existing = getMemory(resolvedId);
        if (!existing) {
          if (globalOpts.json) {
            outputJson({ error: `Memory not found: ${id}` });
          } else {
            console.error(chalk.red(`Memory not found: ${id}`));
          }
          process.exit(1);
        }

        const updateInput: {
          version: number;
          value?: string;
          importance?: number;
          tags?: string[];
          summary?: string | null;
          pinned?: boolean;
          category?: MemoryCategory;
          scope?: MemoryScope;
          status?: MemoryStatus;
        } = {
          version: existing.version,
        };

        if (opts.value !== undefined)
          updateInput.value = opts.value as string;
        if (opts.importance !== undefined)
          updateInput.importance = opts.importance as number;
        if (opts.tags !== undefined)
          updateInput.tags = (opts.tags as string)
            .split(",")
            .map((t: string) => t.trim());
        if (opts.summary !== undefined)
          updateInput.summary = opts.summary as string;
        if (opts.pin) updateInput.pinned = true;
        if (opts.unpin) updateInput.pinned = false;
        if (opts.category !== undefined)
          updateInput.category = opts.category as MemoryCategory;
        if (opts.scope !== undefined)
          updateInput.scope = opts.scope as MemoryScope;
        if (opts.status !== undefined)
          updateInput.status = opts.status as MemoryStatus;

        // Reject out-of-enum values before the write, the way `save` already
        // does. Without this an invalid --scope travelled to the server and came
        // back as an opaque 500 (measured against the deployed image), or hit a
        // bare CHECK constraint locally.
        for (const [flag, value] of [
          ["category", opts.category],
          ["scope", opts.scope],
          ["status", opts.status],
        ] as const) {
          const violation = validateEnumField(flag, value);
          if (violation) throw new Error(formatEnumViolation(violation));
        }

        // `version` is bookkeeping, not a field the caller asked to change. If
        // nothing else is set, the caller requested nothing — and the old code
        // printed "Updated: <key>" and bumped only the version, which is how
        // `update --scope`'s shadowed short flag looked like a successful write.
        // Note this is deliberately a check on "were any field flags supplied",
        // NOT on "did any value differ": setting a field to the value it already
        // holds is a legitimate, idempotent success.
        const changedFields = Object.keys(updateInput).filter((k) => k !== "version");
        if (changedFields.length === 0) {
          throw new Error(
            `Nothing to update: no fields were given for ${existing.key} (${existing.id.slice(0, 8)}). ` +
              `Pass at least one of --value, --scope, --category, --status, --importance, --tags, --summary, --pin/--unpin. ` +
              `Note that -s is the global --session, not --scope.`,
          );
        }

        const updated = updateMemory(resolvedId, updateInput);

        if (globalOpts.json) {
          outputJson({ ...updated, updated_fields: changedFields });
        } else {
          // Name the fields that were written. "Updated" alone cannot be told
          // apart from a write that changed nothing.
          const n = changedFields.length;
          console.log(
            chalk.green(`Updated ${n} field${n === 1 ? "" : "s"}: ${updated.key} (${updated.id.slice(0, 8)})`) +
              chalk.dim(` [${changedFields.join(", ")}]`),
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // forget <key-or-id>
  // ============================================================================

  program
    .command("forget <keyOrId>")
    .description("Delete a memory by key or ID")
    .option("--scope <scope>", "Filter by scope (global, shared, private)")
    .option("--agent <agent>", "Filter by agent ID")
    .option("--project <project>", "Filter by project ID")
    .option("--all", "Delete ALL matching memories (no disambiguation needed)")
    .action((keyOrId: string, opts: { scope?: string; agent?: string; project?: string; all?: boolean }) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();

        // Try by ID first (exact/partial ID always unambiguous).
        // In api mode there is no local table to prefix-match against, so we
        // don't open a local SQLite db; a full id is deleted directly below
        // (via key-lookup fallthrough → direct delete).
        const idMatch = isApiMode()
          ? null
          : resolvePartialId(getDatabase(), "memories", keyOrId);
        if (idMatch) {
          deleteMemory(idMatch);
          if (globalOpts.json) {
            outputJson({ deleted: idMatch });
          } else {
            console.log(chalk.green(`Memory ${idMatch} deleted.`));
          }
          return;
        }

        // Try by key — find ALL matches, then disambiguate
        const matches = getMemoriesByKey(keyOrId, opts.scope, opts.agent, opts.project);

        if (matches.length === 0) {
          // api mode: no key match — the input may be a full cloud id (UUID).
          // Attempt a direct delete (server returns false if absent).
          const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyOrId);
          if (isApiMode() && looksLikeId && deleteMemory(keyOrId)) {
            if (globalOpts.json) {
              outputJson({ deleted: keyOrId });
            } else {
              console.log(chalk.green(`Memory ${keyOrId} deleted.`));
            }
            return;
          }
          if (globalOpts.json) {
            outputJson({ error: `No memory found: ${keyOrId}` });
          } else {
            console.error(chalk.red(`No memory found: ${keyOrId}`));
          }
          process.exit(1);
        }

        if (matches.length === 1) {
          deleteMemory(matches[0]!.id);
          if (globalOpts.json) {
            outputJson({ deleted: matches[0]!.id, key: keyOrId });
          } else {
            console.log(chalk.green(`Memory "${keyOrId}" (${matches[0]!.id}) deleted.`));
          }
          return;
        }

        // Multiple matches
        if (opts.all) {
          const ids = matches.map((m) => m.id);
          for (const id of ids) deleteMemory(id);
          if (globalOpts.json) {
            outputJson({ deleted: ids, key: keyOrId, count: ids.length });
          } else {
            console.log(chalk.green(`Deleted ${ids.length} memories with key "${keyOrId}".`));
          }
          return;
        }

        // Show disambiguation table
        if (globalOpts.json) {
          outputJson({
            error: `Ambiguous key "${keyOrId}" — ${matches.length} memories found. Use --all to delete all, or specify an ID.`,
            matches: matches.map((m) => ({ id: m.id, key: m.key, scope: m.scope, category: m.category, agent_id: m.agent_id })),
          });
        } else {
          console.log(chalk.yellow(`Ambiguous key "${keyOrId}" — ${matches.length} memories found:`));
          for (const m of matches) {
            console.log(`  ${m.id}  scope=${m.scope}  category=${m.category}  agent=${m.agent_id}  ${chalk.dim(m.key)}`);
          }
          console.log(chalk.dim("\nUse --all to delete all, or specify an ID."));
        }
        process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });
}
