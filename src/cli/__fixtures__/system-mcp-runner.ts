import { Command } from "commander";

import { registerMcpCommand } from "../commands/system-mcp.js";

const program = new Command();
registerMcpCommand(program);
program.parse(process.argv);
