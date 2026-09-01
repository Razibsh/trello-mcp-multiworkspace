#!/usr/bin/env node
/**
 * STDIO entry point — for Codex, Claude Code, Claude Desktop and Gemini CLI.
 *
 * No network listener, no auth layer: the client launches this process and
 * passes credentials as environment variables. This is the simplest and
 * safest way to run the server, and it is the recommended default.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createServer } from "./server.js";

async function main(): Promise<void> {
  const config = configFromEnv(process.env);

  if (!config.apiKey || !config.token) {
    // stderr, never stdout: stdout is the JSON-RPC channel.
    process.stderr.write(
      "trello-mcp: TRELLO_API_KEY and TRELLO_TOKEN must be set.\n" +
        "Get them at https://trello.com/power-ups/admin (API key), then generate a token.\n",
    );
    process.exit(1);
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `trello-mcp ready${config.readOnly ? " (read-only)" : ""}` +
      `${config.allowedWorkspaces?.length ? ` [workspaces: ${config.allowedWorkspaces.join(", ")}]` : " [all workspaces]"}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`trello-mcp failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
