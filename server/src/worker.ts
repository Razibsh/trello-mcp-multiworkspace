/**
 * Cloudflare Worker entry point — Streamable HTTP, for Claude.ai and mobile.
 *
 * Auth model (single user, deliberately simple):
 *   - `Authorization: Bearer <MCP_SECRET>` for clients that send headers
 *     (Claude Code, Codex, Gemini CLI).
 *   - `/<MCP_SECRET>/mcp` path form for clients that only accept a bare URL
 *     (Claude.ai custom connectors). The URL then IS the credential — treat
 *     it like a password, never paste it into a shared doc, and rotate by
 *     changing the secret.
 *
 * The Trello token itself never leaves the Worker.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { configFromEnv, createServer } from "./server.js";

interface Env {
  TRELLO_API_KEY: string;
  TRELLO_TOKEN: string;
  TRELLO_ALLOWED_WORKSPACES?: string;
  TRELLO_READ_ONLY?: string;
  MCP_SECRET: string;
}

/** Constant-time-ish comparison so the secret can't be probed by timing. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function authorize(request: Request, url: URL, env: Env): boolean {
  if (!env.MCP_SECRET) return false;

  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer && secretMatches(bearer, env.MCP_SECRET)) return true;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && secretMatches(segments[0], env.MCP_SECRET)) return true;

  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (!url.pathname.endsWith("/mcp")) {
      return new Response("Not found. The MCP endpoint is /mcp.", { status: 404 });
    }

    if (!authorize(request, url, env)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      });
    }

    const config = configFromEnv(env as unknown as Record<string, string | undefined>);
    if (!config.apiKey || !config.token) {
      return new Response(
        JSON.stringify({ error: "server misconfigured: Trello credentials missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const server = createServer(config);
    // Stateless: no sessionIdGenerator, so every request is self-contained
    // and the Worker needs no Durable Object or KV to hold session state.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // Free the isolate's handles; a new server is built per request.
      await server.close().catch(() => {});
    }
  },
};
