---
name: trello-mcp-setup
description: Stand up a private multi-workspace Trello MCP server on Cloudflare Workers and connect it to Claude, ChatGPT, Gemini, Cursor, Codex and Claude Code. Use this whenever someone wants an AI assistant to read or write their Trello, wants tasks to live in one place across several AI tools, is frustrated that the official Trello MCP only sees one workspace, or asks to connect Trello to Claude/ChatGPT/Gemini/Cursor. Also use for maintaining an existing deployment - rotating its secret, regenerating the Trello token, or adding a new client. Complete server source is bundled, so nothing needs to be written from scratch.
---

# Trello MCP: one server, every workspace, every AI

## The problem this solves

Trello's own MCP is scoped to **one workspace per connection**, and Atlassian says
multi-workspace support is "planned." That limit is server-side, so it applies equally to
Claude, ChatGPT and Gemini. Anyone who keeps several Trello workspaces — usually because a
workspace is a *permission boundary*, separating clients or collaborators — hits a wall
where the AI can only see one slice of their work.

The fix is a small custom MCP server that talks to the Trello REST API directly. A Trello
API key + member token reaches every workspace that member can see. This changes nothing
about Trello permissions — collaborators still see exactly what Trello grants them. It only
removes the one-workspace ceiling on the AI side.

**Never suggest merging workspaces to work around this.** People separate them deliberately,
and merging would expose private boards to collaborators. That's a data-exposure bug dressed
up as a simplification.

## What gets built

A stateless Cloudflare Worker exposing 23 tools (v1.1.0):

`list_workspaces` · `list_boards` · `get_board` · `get_board_activity` · `list_cards` · `my_tasks` · `search_cards` · `get_card` · `get_card_comments` · `create_board` · `create_list` · `update_list` · `create_label` · `create_card` · `update_card` · `assign_card` · `move_card` · `archive_card` · `add_comment` · `update_comment` · `attach_link` · `add_checklist` · `set_checklist_item`

There is deliberately no `create_workspace`: a workspace is a permission boundary and
creating one should stay a human act. There is no delete of anything - archive only.

`my_tasks` is the headline: every card assigned to the user across *all* workspaces, sorted
by due date. That's the thing a per-workspace connection structurally cannot do — lead with
it when explaining the value.

Complete source is in `assets/server/`. Copy it to a working directory; don't rewrite it.

## Guard rails worth keeping

These are deliberate. If asked to change them, explain the reasoning first.

- **Archive, never delete.** There is no delete tool. Archiving is reversible from Trello's
  UI, so a confused model can't destroy anything. Don't add deletion.
- **Name resolution refuses on ambiguity.** When a board name matches several boards, the
  tool returns the candidates instead of guessing. This is what stops a model writing a work
  task onto a shared client board. Don't "improve" it into a fuzzy best-guess.
- **Secrets live in the OS keychain, never in config files.** A wrapper script fetches them
  at launch. This matters more than usual here because the Trello token has full read+write
  over the user's entire Trello and does not expire on its own.

## Build it

Work through this in order. Steps 1-3 need the user's hands — they involve their accounts.

### 1. Trello app and API key

Direct the user to https://trello.com/power-ups/admin → **New**. Fields that matter:

- **Workspace** — this is the one people get wrong. It does *not* limit what the API key can
  reach; the token does that. What it controls is **who can administer the app**: workspace
  admins and app collaborators. So it must be a workspace the user controls alone, never one
  shared with a collaborator, and never a throwaway they plan to delete.
- **Iframe connector URL** — required by the form, but inert here. The Power-Up is never
  published or enabled on a board, so Trello never loads it. Any HTTPS URL the user owns works.
- Support contact, icon, categories, listings — all irrelevant. Skip them.

Then **API key** tab → *Generate a new API Key*. The "replace the API key used for GDPR
compliance" warning is boilerplate for published Power-Ups; a brand-new app has nothing to
replace. The **Secret** on that page is for OAuth 1 signing and is not used — leave it alone.

Store the key without it passing through the conversation:

```bash
security add-generic-password -a "$USER" -s trello-api-key -U -w   # macOS, prompts hidden
```

### 2. Trello token — build the authorize URL, don't use the page link

The **Token** link next to the API key produces a token with default scope. That is the
single most common way this setup silently half-works: one workspace shows up, days later.
Build the URL explicitly instead:

```bash
KEY=$(security find-generic-password -s trello-api-key -w | tr -d '\n')
open "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Trello%20MCP&key=$KEY"
```

`expiration=never` and `scope=read,write` are the parts that matter. Don't request `account`
scope — the tools never need profile or email data.

After the user approves, store it: `security add-generic-password -a "$USER" -s trello-token -U -w`

### 3. Verify against real Trello before deploying anything

```bash
TRELLO_API_KEY=$(security find-generic-password -s trello-api-key -w) \
TRELLO_TOKEN=$(security find-generic-password -s trello-token -w) npm run verify
```

Read-only; creates nothing. It must list **every** workspace the user expects. If only one
comes back, the token was made with narrow scope — redo step 2. Catching this here costs a
minute; catching it after connecting six clients costs an hour.

### 4. Deploy

```bash
npm install && npm run build
openssl rand -hex 32   # -> MCP_SECRET, straight into the keychain, never printed
npx wrangler login     # browser OAuth; the user approves
npx wrangler secret put TRELLO_API_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put MCP_SECRET
npx wrangler deploy
```

Pipe each secret from the keychain rather than typing it:
`security find-generic-password -s trello-mcp-secret -w | tr -d '\n' | npx wrangler secret put MCP_SECRET`

`wrangler login` requests broad-looking scopes. Worth stating accurately if the user asks:
zones are **read-only** (`zone:read`) — it cannot edit DNS. The write scopes are Workers, KV,
D1, Pages, Queues, plus `ssl_certs`, `email_routing` and `email_sending`.

Run `npm run build` before `node scripts/smoke.mjs` — the smoke test executes `dist/stdio.js`
and `dist/` is gitignored, so it fails confusingly on a fresh clone.

### 5. Verify the deployment, including that auth actually rejects

Don't just check that the happy path works. Confirm the server refuses bad credentials —
otherwise a misconfiguration reads as success:

```bash
B=https://trello-mcp.<subdomain>.workers.dev
S=$(security find-generic-password -s trello-mcp-secret -w | tr -d '\n')
I='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
H='Content-Type: application/json'; A='Accept: application/json, text/event-stream'
curl -s $B/health                                                                   # ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/mcp -H "$H" -H "$A" -d "$I"      # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/$S/mcp -H "$H" -H "$A" -d "$I"   # 200
```

Then call `list_workspaces` through the live Worker and confirm every workspace appears.

## Connecting clients

Every client is one of two kinds. Getting this distinction across saves enormous confusion —
users repeatedly try to paste a URL into a field that wants a command.

**Local** (Claude Code, Cursor, Codex): takes a **command**, no URL, no secret. Point it at a
wrapper script that reads the keychain. Unaffected by secret rotation.

**Remote** (Claude connectors, ChatGPT web plugin, Gemini): takes the **path-secret URL**,
`https://<worker>/<MCP_SECRET>/mcp`.

**Anything on a phone can only ever be remote** — a phone cannot launch a process on a laptop.
This is the single most useful thing to tell someone who wants their AI to manage tasks on
mobile.

Create the wrapper first (adjust paths):

```sh
#!/bin/sh
TRELLO_API_KEY=$(security find-generic-password -s trello-api-key -w) || exit 1
TRELLO_TOKEN=$(security find-generic-password -s trello-token -w) || exit 1
export TRELLO_API_KEY TRELLO_TOKEN
exec node "$HOME/path/to/trello-mcp/dist/stdio.js" "$@"
```

Per-client steps — including the exact dialog fields, which differ in ways that matter — are
in `references/clients.md`. Read it before walking someone through a specific client.

## The two failure modes you will actually hit

**Pasting the bare `/mcp` URL with no credential.** It returns 401, the client attempts OAuth,
the server doesn't speak OAuth, and the connector fails to add with an unhelpful error. Every
remote client needs either the path-secret URL *or* an `Authorization: Bearer` header.

**Leaving the official Trello connector installed alongside this one.** The model then has two
Trello tools and picks one silently — often the crippled one. The user gets "you have one
workspace," with no indication which tool answered. Always have them remove the official
connector from any client where this server is added.

## Security posture — say this plainly

**The path-secret URL is a password.** Anyone holding it gets full read+write to every Trello
workspace, with no login and no 2FA. It must never appear in a screenshot, a shared document,
a ticket, or a chat transcript. Connector settings pages display it in full — warn before the
user screenshots one.

If it leaks, rotation takes about a minute and invalidates the old URL instantly. The Trello
token is unaffected and does not need regenerating. Local clients keep working; only remote
ones need re-pasting. `references/troubleshooting.md` has the exact procedure — including
verifying the old secret now returns 401, which is the step people skip.

Two config knobs worth knowing the difference between:

- `TRELLO_READ_ONLY=true` is a **hard** guard — the 7 write tools are never registered.
- `TRELLO_ALLOWED_WORKSPACES` is a **soft** guard — it filters the list tools, but
  `get_card`/`list_cards` don't re-check it, so a raw board id gets through. Don't present it
  as a security boundary.

## Reference files

- `references/clients.md` — exact per-client setup for Claude, ChatGPT, Gemini, Cursor,
  Codex, Claude Code, including which surfaces reach mobile
- `references/troubleshooting.md` — rotation, token regeneration, rebuild-from-scratch, and
  the symptoms of each common failure
- `assets/server/` — complete server source; copy, `npm install`, `npm run build`
