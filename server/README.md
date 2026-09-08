# trello-mcp

One MCP server that reaches **your entire Trello account** — every workspace, every board — instead of the single workspace Trello's official MCP is limited to.

> Atlassian's docs: *"Each Trello MCP connection supports one workspace. Multi-workspace support is planned for a future release."*

This server talks to the Trello REST API directly, authenticating as you. It changes **nothing** about Trello permissions — collaborators still see only the workspaces and boards Trello grants them. It just removes the one-workspace ceiling on the AI side.

## What you get

- **`my_tasks`** — every card assigned to you across all workspaces, in one call. This is the tool that makes the whole thing worth building.
- **Name-based addressing** — "create a card in SHYFT → Development → Backlog". No 24-character ids.
- **Refuses to guess** — if a board name is ambiguous across workspaces, the tool returns the candidates and asks, rather than writing to the wrong board.
- **Workspace allowlist** — let the AI see three workspaces and not the other two, without touching Trello itself.
- **Read-only mode** — one env var flips off every write tool.
- **Two transports, one codebase** — STDIO for Codex / Claude Code / Gemini CLI, Streamable HTTP on Cloudflare for Claude.ai.

## 1. Get your Trello credentials

1. Go to **https://trello.com/power-ups/admin** and create a Power-Up (any name — this exists only to issue you an API key).
2. Copy the **API key**.
3. On the same page click **Token**, approve, and copy the **token**.

The key is public-ish. **The token is a password** — it can do anything you can do in Trello, and it does not expire on its own. Keep it in secrets, never in a file you commit or paste into a chat.

## 2. Verify before connecting anything

```bash
npm install
TRELLO_API_KEY=xxx TRELLO_TOKEN=yyy npm run verify
```

This only reads. It prints every workspace and board the token can see — confirm your list looks right before you wire an AI to it. If only one workspace comes back, regenerate the token.

## 3a. Run it locally (STDIO) — Codex, Claude Code, Gemini CLI

```bash
npm run build
```

**Codex** (Settings → Plugins → MCPs → Add → Connect to a custom MCP, type **STDIO**):

- Command to launch: `node`
- Arguments: `/absolute/path/to/trello-mcp/dist/stdio.js`
- Environment variables: `TRELLO_API_KEY` = your key, `TRELLO_TOKEN` = your token

**Claude Code:**

```bash
claude mcp add trello -e TRELLO_API_KEY=xxx -e TRELLO_TOKEN=yyy \
  -- node /absolute/path/to/trello-mcp/dist/stdio.js
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trello": {
      "command": "node",
      "args": ["/absolute/path/to/trello-mcp/dist/stdio.js"],
      "env": { "TRELLO_API_KEY": "xxx", "TRELLO_TOKEN": "yyy" }
    }
  }
}
```

**Gemini CLI** — in `~/.gemini/settings.json`, same `mcpServers` shape as above.

STDIO is the safest option: no public endpoint, no auth layer, credentials never leave your machine. Use it wherever it's available.

## 3b. Deploy to Cloudflare (Streamable HTTP) — Claude.ai and mobile

```bash
npx wrangler login
openssl rand -hex 32          # your MCP_SECRET — save it

npx wrangler secret put TRELLO_API_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put MCP_SECRET

npx wrangler deploy
```

You'll get a URL like `https://trello-mcp.<your-subdomain>.workers.dev`.

Two ways to authenticate, both accepted:

| Client | How |
|---|---|
| Claude Code, Codex, Gemini CLI | `Authorization: Bearer <MCP_SECRET>` header, URL `.../mcp` |
| Claude.ai custom connector | URL `https://trello-mcp.<sub>.workers.dev/<MCP_SECRET>/mcp` |

**On the second form, be clear-eyed:** the secret is in the URL, so the URL *is* the credential. Anyone who gets that link has full write access to your Trello. Never paste it into a shared doc, a screenshot, or a chat with someone else. To rotate, run `wrangler secret put MCP_SECRET` with a new value and re-add the connector. It's in there because Claude.ai's custom-connector form has no header field — not because it's the best design.

If you'd rather not have a public endpoint at all, use STDIO (3a) and skip this section.

Local test before deploying:

```bash
cp .dev.vars.example .dev.vars   # fill it in
npm run dev
curl -s -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $MCP_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 4. Optional guard rails

Set as Worker vars (`wrangler.jsonc`) or STDIO env vars:

| Variable | Effect |
|---|---|
| `TRELLO_ALLOWED_WORKSPACES` | Comma-separated workspace names. The AI cannot see or touch anything outside this list, even by id. Empty = all workspaces. |
| `TRELLO_READ_ONLY` | `true` removes every write tool from the server. Good for the first week. |

The allowlist is enforced inside the API client, not just in the tool layer, so a model can't route around it.

## Tools

| Tool | What it does |
|---|---|
| `list_workspaces` | Every workspace you can see |
| `list_boards` | Open boards, optionally filtered by workspace |
| `get_board` | One board's lists, labels and members |
| `list_cards` | Cards on a board or a single list |
| `my_tasks` | **Cards assigned to you across all workspaces**, optional due-date window |
| `search_cards` | Full-text search, all workspaces or scoped |
| `get_card` | Full card detail including checklists |
| `create_card` | Create by workspace/board/list name |
| `update_card` | Title, description, due date, due-complete |
| `move_card` | Move between lists or across boards |
| `archive_card` | Archive (reversible — nothing is hard-deleted) |
| `add_comment` | Comment on a card |
| `add_checklist` | Create a checklist, optionally with items |
| `set_checklist_item` | Tick / untick an item |

There is deliberately no delete tool. Trello's own MCP made the same call, and it's the right one — archive is reversible, delete isn't.

## Testing

```bash
npm run typecheck
npm run build
node scripts/smoke.mjs     # offline: handshake + all 23 tools, no Trello calls
npm run verify             # live: credentials and workspace scope (read-only)
```

## Known limits

- Custom Fields are a paid Trello feature and aren't exposed here. On the free plan use labels.
- Trello rate limits at 300 req/10s per key and 100 req/10s per token. The client retries 429s with backoff.
- Board and list structure is cached for 60 seconds. Card data is never cached.
- Attachments and board creation aren't implemented — add them if you need them; the client is the place to start.
