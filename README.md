# Trello MCP — one server, every workspace, every AI

A small [MCP](https://modelcontextprotocol.io) server that gives any AI assistant read and
write access to **all** of your Trello workspaces at once, from a single connection.

## Why

Trello's official MCP is scoped to **one workspace per connection** — Atlassian says
multi-workspace support is "planned." That limit is server-side, so it applies equally to
Claude, ChatGPT and Gemini.

If you keep several Trello workspaces — usually because a workspace is a *permission
boundary*, separating clients or collaborators — your AI can only ever see one slice of your
work. Merging the workspaces to work around it would expose private boards to collaborators,
which is a data-exposure bug dressed up as a simplification.

This server talks to the Trello REST API directly. An API key + member token reaches every
workspace that member can see. It changes nothing about Trello permissions; collaborators
still see exactly what Trello grants them. It only removes the one-workspace ceiling on the
AI side.

## What you get

A stateless Cloudflare Worker (free tier) exposing 23 tools:

`list_workspaces` · `list_boards` · `get_board` · `get_board_activity` · `list_cards` · `my_tasks` ·
`search_cards` · `get_card` · `get_card_comments` · `create_board` · `create_list` · `update_list` ·
`create_label` · `create_card` · `update_card` · `assign_card` · `move_card` · `archive_card` ·
`add_comment` · `update_comment` · `attach_link` · `add_checklist` · `set_checklist_item`

`my_tasks` is the one that justifies the whole thing: every card assigned to you across
*every* workspace, sorted by due date. A per-workspace connection structurally cannot do that.

Connect it to Claude (web, desktop, mobile, Cowork), ChatGPT (web, desktop, mobile), Gemini
Spark, Cursor, Codex and Claude Code — all from one deployment.

## Getting started

**With Claude Code** — install `skill/` as a skill and say *"set up the Trello MCP"*. It walks
you through Trello app creation, token scoping, deployment and connecting each client.

**By hand** — `server/` is the complete source. See [`skill/SKILL.md`](skill/SKILL.md) for the
build steps, [`skill/references/clients.md`](skill/references/clients.md) for per-client setup,
and [`skill/references/troubleshooting.md`](skill/references/troubleshooting.md) for
rotation and recovery.

```bash
cd server && npm install && npm run build
# create a Trello app + token, then:
npx wrangler login
npx wrangler secret put TRELLO_API_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put MCP_SECRET      # openssl rand -hex 32
npx wrangler deploy
```

Run `npm run verify` (read-only) before deploying — it must list **every** workspace you
expect. If only one comes back, your token was created with narrow scope.

## Design decisions

| Decision | Why |
|---|---|
| Archive, never delete | There is no delete tool. Archiving is reversible, so a confused model can't destroy anything. |
| Name resolution refuses on ambiguity | Returns candidates instead of guessing — the guard against writing a work task onto a shared client board. |
| Secrets in the OS keychain, never in config files | The Trello token has full read+write over your entire Trello and doesn't expire on its own. |
| Single-user | Multi-user OAuth needs a user store, refresh and per-user sessions — a real project, not an increment. |

## Security

The server takes a shared secret, either as `Authorization: Bearer <secret>` or embedded in
the URL path for clients that only accept a bare URL.

**The path-secret URL is a password.** Anyone holding it gets full read+write to every Trello
workspace with no login and no 2FA. Keep it out of screenshots, shared docs and tickets —
connector settings pages display it in full. Rotation takes about a minute and is documented
in the troubleshooting reference.

`TRELLO_READ_ONLY=true` is a hard guard: the write tools are never registered.
`TRELLO_ALLOWED_WORKSPACES` only filters the list tools, so treat it as tidiness rather than a
security boundary.

## Requirements

Node 22+, a Cloudflare account (free tier is enough), a Trello account.
Trello free plan works; Custom Fields are a paid feature and are not exposed.

## License

MIT
