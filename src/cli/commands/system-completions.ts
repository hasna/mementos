import type { Command } from "commander";

export function registerCompletionsCommand(program: Command): void {
  program
    .command("completions <shell>")
    .description("Output shell completion script (bash, zsh, fish)")
    .action((shell: string) => {
      const commands = "init setup save recall list update forget search stats export import clean inject context pin unpin archive versions stale doctor tail diff register-agent agents projects bulk completions config backup restore report profile mcp";
      const commandList = commands.split(" ");

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
          const descriptions: Record<string, string> = {
            save: "Save a memory",
            recall: "Recall a memory by key",
            list: "List memories",
            update: "Update a memory",
            forget: "Delete a memory",
            search: "Search memories",
            stats: "Show memory statistics",
            export: "Export memories to JSON",
            import: "Import memories from JSON",
            clean: "Clean expired memories",
            inject: "Inject memories into a prompt",
            context: "Get context-relevant memories",
            pin: "Pin a memory",
            unpin: "Unpin a memory",
            doctor: "Check database health",
            tail: "Watch recent memories",
            diff: "Show memory changes",
            init: "One-command onboarding setup (MCP + hook + auto-start)",
            "register-agent": "Register an agent (returns ID)",
            agents: "Manage agents",
            projects: "Manage projects",
            bulk: "Bulk operations",
            completions: "Output shell completion script",
            config: "Manage configuration",
            backup: "Backup the database",
            restore: "Restore from a backup",
          };
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
