// MCP over stdio, for Claude Code / Claude Desktop through SSH — no domain or HTTPS needed:
//   claude mcp add zalo -- ssh vps "cd zalo-digest && USER_DIR=users/an npm run -s mcp-stdio"
// Opens the same SQLite file as the main process (WAL + busy_timeout make that safe); never touches Zalo.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../mcp.js";

await createMcpServer().connect(new StdioServerTransport());
