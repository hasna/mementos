# CLI reference

The `mementos` binary uses Commander. The command tree below mirrors the
commands registered by `src/cli/register-all.ts`; run `mementos <command>
--help` for the exact options accepted by the installed version.

## Global options

```text
-p, --project <path>  Project path for scoping
-j, --json            Output as JSON
-f, --format <fmt>    Output format: compact, json, csv, yaml
-a, --agent <name>    Agent name or ID
-s, --session <id>    Session ID
-V, --version         Print the package version
-h, --help            Show help
```

Global short flags are reserved throughout the command tree. In particular,
`-s` always means `--session`; use the long `--scope` option for a memory scope.
JSON output can be selected with global `--json`, even when it appears after a
subcommand. A command-specific `--format` lists any additional formats it
supports.

Required arguments are shown as `<name>` and optional arguments as `[name]`.

## Memory commands

| Command | Purpose | Main options |
| --- | --- | --- |
| `save <key> <value>` | Create or upsert a memory | `--category`, `--scope`, `--importance`, `--tags`, `--summary`, `--ttl`, `--source`, `--template`, `--dedupe` |
| `update <id>` | Update a memory by full or partial ID | `--value`, `--importance`, `--tags`, `--summary`, `--pin`, `--unpin`, `--category`, `--scope`, `--status` |
| `forget <keyOrId>` | Delete by ID or an unambiguous key | `--scope`, `--agent`, `--project`, `--all` |
| `remove <nameOrId>` | Delete by name or ID; compatibility alias | `--agent`, `--scope` |
| `recall <key>` (alias `get`) | Recall an exact key. Exits 1 if absent; `--fuzzy` returns the nearest record instead and exits 2 | `--scope`, `--agent`, `--project`, `--fuzzy` |
| `show <id>` | Show the full record; partial IDs work locally | — |
| `list` | List memories with filters | `--scope`, `--category`, `--tags`, `--importance-min`, `--pinned`, `--agent`, `--project`, `--session`, `--status`, paging/output options |
| `search <query>` | Full-text and fuzzy search | scope/category/tag/project/agent/session filters, paging/output options, `--verbose`, `--history`, `--popular` |
| `pin <keyOrId>` / `unpin <keyOrId>` | Change pin state | `--scope`, `--agent`, `--project` |
| `archive <keyOrId>` | Hide a memory while retaining its history | `--scope` |
| `versions <keyOrId>` | Show stored versions | `--scope` |
| `diff <id>` | Compare version N with N-1 | `-v, --version <n>` |
| `chain <sequence_group>` | Show an ordered procedural memory chain | — |
| `when-to-use <memory_id>` | Show activation guidance | — |
| `bulk <action> <ids...>` | Apply `forget`, `archive`, `pin`, or `unpin` to IDs | — |
| `tail` | Poll and print new or updated memories | `--scope`, `--category`, `--agent`, `--project`, `--interval`, `--notify` |
| `watch` | Watch memories with broader filters | `--scope`, `--category`, `--agent`, `--project`, `--interval` |

`save` accepts scopes `global`, `shared`, `private`, and `working`; categories
`preference`, `fact`, `knowledge`, `history`, `procedural`, and `resource`; and
sources `user`, `agent`, `system`, `auto`, and `imported`. Importance is 1–10.
TTL values accept milliseconds or values such as `30s`, `5m`, `2h`, `1d`, and
`1w`.

Templates set defaults which explicit flags can override:

| Template | Scope | Category | Importance | Tag |
| --- | --- | --- | --- | --- |
| `correction` | shared | knowledge | 9 | `correction` |
| `preference` | global | preference | 8 | — |
| `decision` | shared | fact | 8 | `decision` |
| `learning` | shared | knowledge | 7 | `learning` |

The default `--dedupe merge` upserts only when key, scope, agent, project, and
session all match. If the same active key exists in a different bucket, `save`
fails rather than silently forking it. Use `--dedupe create` for an intentional
second active row, or update the existing ID.

`update` requires at least one field option. It obtains the current version
before writing; callers do not pass a version on the CLI.

### `recall` exit status — reading it is enough

`recall` (and its alias `get`) answers "does this exact key exist", and the exit
status alone is a sufficient answer. No caller needs to parse the output:

| exit | meaning |
| --- | --- |
| `0` | the requested key was found, exactly — the printed record IS the one asked for |
| `1` | nothing was returned |
| `2` | `--fuzzy` only: a **different** record was substituted for the requested key |

Without `--fuzzy`, only `0` and `1` are reachable and nothing is printed on a
miss. With `--fuzzy`, the nearest record is returned when the exact key is
absent, but the status is `2` rather than `0`, so a shell `if` still treats it as
a miss while a caller that cares can tell a neighbour from an empty result. In
`--json`, a substitution carries `fuzzy_match: true` plus `requested_key` and
`returned_key`.

Previously `recall` had no `--fuzzy` flag: the fallback was unconditional and
exited `0` while returning a different record. Because the search only reaches
for a neighbour when one is *near*, it failed closed on an invented key and open
on a near miss — so negative controls built from invented strings passed while
the command was substituting records. Scripts written against that behaviour
should either add `--fuzzy` to keep the fallback (and accept exit `2`) or, more
usually, keep the new default, which is what an existence check wanted anyway.

### Paging and output

Human list/search/history surfaces fetch a compact first page and print a next
page hint. Common options are:

```text
--limit <n>    Maximum results
--offset <n>   Numeric offset
--cursor <n>   Alias for the next offset; takes precedence over --offset
--verbose      Wider snippets and, for search, match highlights
--format <fmt> compact, json, csv, or yaml where advertised
```

Use `show <id>` for a complete human-readable record. `--json` returns stable
objects rather than the compact display.

## Information and maintenance

| Command | Purpose | Options |
| --- | --- | --- |
| `stats` | Active-memory counts and breakdowns | `--format compact|json|csv|yaml` |
| `report` | Activity and top-memory summary | `--days`, `--project`, `--markdown`, `--json` |
| `stale` | Memories not accessed recently | `--days`, `--project`, `--agent`, paging, `--format`, `--verbose` |
| `history` | Recently accessed memories | paging, `--verbose` |
| `context [query]` | Prompt-ready relevant memory block | `--max-tokens`, `--min-importance`, `--scope`, `--categories`, `--agent`, `--project`, `--machine` |
| `clean` | Remove expired memories and enforce configured retention | — |
| `export` | Write a JSON export to stdout | `--scope`, `--category`, `--agent`, `--project` |
| `import [file]` | Import JSON from a file or stdin | `--overwrite` |
| `backup [path]` | Copy the local SQLite database | `--list` |
| `restore [file]` | Preview or restore a local SQLite backup | `--latest`, `--force` |

`restore` is unavailable in client API mode. Cloud database backup and restore
are server/operator responsibilities. Without `--force`, restore only prints a
preview.

## Agents and projects

| Command | Purpose | Options |
| --- | --- | --- |
| `register-agent <name>` (`init-agent`) | Register an agent | `--description`, `--role`, `--project <id>` |
| `agents` | List agents | paging |
| `agent-update <id>` | Change an agent | `--name`, `--description`, `--role` |
| `heartbeat [agent-id]` | Refresh `last_seen_at` | global `--agent` may supply the ID |
| `set-focus [project]` | Set or clear an agent's active project | `--agent <id>` |
| `get-focus` | Show active project focus | `--agent <id>` |
| `projects` | List projects or register one | `--add --name <name> --path <path> [--description]`, paging |
| `inject` | Produce memory context | `--agent`, `--project`, `--session`, `--machine`, `--max-tokens`, `--categories`, `--format xml|compact|markdown|json` |
| `project-panel` | Emit the Projects dashboard contract | `--project`, `--limit`, `--contract` |

`projects --add` requires both `--name` and `--path`. `register-agent` is
idempotent by name when no conflicting active registration exists.

## Knowledge graph

```text
entity create <name> --type <type> [--description <text>] [--project <path>]
entity show <nameOrId> [--type <type>] [--verbose]
entity list [--type <type>] [--project <path>] [--search <query>] [paging/output]
entity delete <nameOrId> [--type <type>]
entity merge <source> <target>
entity link <entity> <memoryKeyOrId> [--role subject|object|context] [--type <type>]

relation create <source> <target> --type <relationType> [--weight <n>]
relation list <entityNameOrId> [--type <type>] [--direction outgoing|incoming|both] [paging/output]
relation delete <id>

graph show <entityNameOrId> [--depth <n>]
graph path <from> <to>
graph stats
```

Entity types are `person`, `project`, `tool`, `concept`, `file`, `api`,
`pattern`, and `organization`. Relation types are `uses`, `knows`,
`depends_on`, `created_by`, `related_to`, `contradicts`, `part_of`,
`implements`, `happened_before`, `happened_after`, `caused_by`, `resulted_in`,
`supersedes`, and `version_of`. The CLI create help lists the eight core
relation types; the domain and REST types also accept the six temporal/version
relations.

## Consolidation and reflection

```text
consolidate [--dry-run] [--scope <scope>] [--project <idOrPath>]
  [--agent <nameOrId>] [--duplicate-threshold <n>] [--stale-days <n>]
  [--decay-threshold <n>] [--limit <n>] [--format compact|json]

reflect --on session|task|range [--source <idOrRange>] [--dry-run]
  [--project <idOrPath>] [--agent <nameOrId>] [--since <iso>]
  [--until <iso>] [--provider <name>] [--model <name>]
  [--max-tokens <n>] [--format compact|json]
```

`consolidate` plans duplicate merges, semantic promotion, cluster summaries,
and decay cleanup. `reflect` produces structured `worked`, `failed`, and
`do_differently` lessons. Use `--dry-run` before either workflow when reviewing
its effects.

## Automation and sessions

```text
auto-memory process <turn> [--agent <id>] [--project <id>] [--session <id>] [--sync]
auto-memory status
auto-memory config [--provider <name>] [--model <name>] [--min-importance <n>]
auto-memory test <turn> [--provider <name>] [--agent <id>] [--project <id>]
auto-memory enable | disable

session ingest <transcriptFile> [--session-id <id>] [--agent <id>]
  [--project <id>] [--source claude-code|codex|manual|open-sessions]
session status <jobId>
session list [--agent <id>] [--project <id>] [--status <status>] [--limit <n>]
session setup-hook [--claude] [--codex] [--show]

sessions list [--project <name>] [--agent <name>] [paging/output]
sessions send <message> [--agent <name>] [--project <name>] [--all]
sessions clean
```

The singular `session` group manages transcript extraction jobs. The plural
`sessions` group manages the local active-session registry.

## Hooks and synthesis

```text
hooks list [--type <type>] [paging]
hooks stats
hooks webhooks list [--type <type>] [--disabled] [paging]
hooks webhooks create <type> <url> [--blocking] [--priority <n>]
  [--agent <id>] [--project <id>] [--description <text>]
hooks webhooks delete <id> | enable <id> | disable <id>

synthesis run [--project <id>] [--dry-run] [--max-proposals <n>] [--provider <name>]
synthesis status [--project <id>] [--limit <n>]
synthesis rollback <runId>
synthesized-profile [--project-id <id>] [--refresh]
```

`synth` is an alias for `synthesis`. The separate top-level `events` and
`webhooks` groups come from the installed `@hasna/events` version; use their own
`--help` output for transport-specific options.

## Storage and diagnostics

```text
storage mode [--json]
storage status [--json]
storage push|pull|sync [--tables <comma-separated>] [--json]
storage migrate [--connection-string <url>] [--dry-run] [--json]
storage feedback <message> [--email <email>] [--category <category>] [--json]

doctor
config [get <key>|set <key> <value>|reset [key]|path]
profile list|get|set <name>|unset|delete <name> [--yes]
migrate-pg [--connection-string <url>] [--dry-run] [--json]
feedback <message> [--email <email>] [--category bug|feature|general]
```

`storage mode` is the safe backend probe: it performs no database or network
access and does not print credential values. Live PostgreSQL migration mutates a
remote database; dry-run performs validation and redaction without connecting.
Direct database credentials are for server/administrative environments, never
fleet clients. See [Configuration and storage](CONFIGURATION.md).

The profile commands manage profile files and the persisted active-profile
setting. The primary database resolver currently selects its live SQLite path
using the rules documented in [Configuration and storage](CONFIGURATION.md);
verify the effective store with `storage mode` before writing.

## Other command groups

```text
init
mcp --claude|--codex|--gemini|--all [--uninstall]
completions bash|zsh|fish
tool-events [tool_name] [--limit <n>] [--offset <n>] [--cursor <n>] [--project-id <id>]
tool-insights <tool_name> [--project-id <id>] [--limit <n>]

brains gather [--limit <n>] [--since <date>] [--output <dir>] [--json]
brains train [--base-model <model>] [--provider openai|thinker-labs]
  [--dataset <path>] [--name <name>] [--json]
brains model [get|set <modelId>|clear]
```

`brains train` requires the optional `@hasna/brains` package. `init` configures
Claude MCP, a stop hook, and macOS launchd auto-start where supported. Because
the MCP binary now defaults to HTTP, stdio host configurations should invoke
`mementos-mcp --stdio`; see the [MCP reference](MCP.md).
