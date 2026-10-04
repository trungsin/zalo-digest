// MCP over stdio, for Claude Code / Claude Desktop through SSH — no domain or HTTPS needed:
//   claude mcp add zalo -- ssh vps "cd zalo-digest && USER_DIR=users/an npm run -s mcp-stdio"
// Opens the same SQLite file as the main process (WAL + busy_timeout make that safe); never touches Zalo.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";

if (!process.env.USER_DIR) throw new Error("MCP stdio requires USER_DIR to explicitly select one account.");
const { createMcpServer } = await import("../mcp.js");
const { config } = await import("../config.js");
const identityFile = path.join(config.dataDir, "account.json");
const identity = fs.existsSync(identityFile) ? JSON.parse(fs.readFileSync(identityFile, "utf8")) as { zalo_uid: string } : undefined;

await createMcpServer(undefined, identity && { username: config.userName, zalo_uid: identity.zalo_uid }).connect(new StdioServerTransport());
