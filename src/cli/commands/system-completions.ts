import type { Command } from "commander";

/**
 * Collect the real top-level subcommand names registered on the program.
 *
 * Deriving these from commander (rather than a hand-maintained string) keeps the
 * shell completion script in sync with the actual CLI as commands are added or
 * removed. Enumeration happens at action time, so every command group registered
 * on `program` — including ones registered after the completions command itself —
 * is included.
 */
export function collectSubcommandNames(program: Command): string[] {
  const names = new Set<string>();
  for (const cmd of program.commands) {
    // Skip commander's implicit help command and any hidden commands.
    if ((cmd as { _hidden?: boolean })._hidden) continue;
    const name = cmd.name();
    if (!name || name === "help") continue;
    names.add(name);
  }
  return [...names].sort();
}

export function registerCompletionsCommand(program: Command): void {
  program
    .command("completions <shell>")
    .description("Output shell completion script (bash, zsh, fish)")
    .action((shell: string) => {
      const commandList = collectSubcommandNames(program);
      const commands = commandList.join(" ");

      switch (shell.toLowerCase()) {
        case "bash": {
          console.log(`_mementos_completions() {
  local commands="${commands}"
  local scopes="global shared private"
  local categories="preference fact knowledge history"

  if [ "\${#COMP_WORDS[@]}" -eq 2 ]; then
    COMPREPLY=($(compgen -W "$commands" -- "\${COMP_WORDS[1]}"))
  elif [ "\${COMP_WORDS[1]}" = "recall" ] || [ "\${COMP_WORDS[1]}" = "forget" ] || [ "\${COMP_WORDS[1]}" = "pin" ] || [ "\${COMP_WORDS[1]}" = "unpin" ]; then
    COMPREPLY=()
  fi
}
complete -F _mementos_completions mementos`);
          break;
        }
        case "zsh": {
          console.log(`#compdef mementos
_mementos() {
  local commands=(${commands})
  _arguments '1:command:($commands)'
}
compdef _mementos mementos`);
          break;
        }
        case "fish": {
          const descriptions: Record<string, string> = Object.fromEntries(
            program.commands.map((cmd) => [cmd.name(), cmd.description()])
          );
          const lines = commandList.map(
            (cmd) => `complete -c mementos -n "__fish_use_subcommand" -a "${cmd}" -d "${descriptions[cmd] || cmd}"`
          );
          console.log(lines.join("\n"));
          break;
        }
        default:
          console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
          process.exit(1);
      }
    });
}
