# Connecting each client

All of this was established by working through every client end to end. Where a route is
marked dead, it was tried and it failed — don't spend time re-litigating it.

## Quick reference

| Client | Kind | Reaches mobile? | Config lives |
|---|---|---|---|
| Claude Code | local (command) | n/a | `~/.claude.json`, user scope |
| Cursor | local (command) | n/a | `~/.cursor/mcp.json` |
| Codex CLI | local (command) | n/a | `~/.codex/config.toml` |
| Claude web/desktop/mobile/Cowork | remote (URL) | **yes** | the Claude **account** |
| ChatGPT (web Plugin) | remote (URL) | **yes** | the ChatGPT **account** |
| ChatGPT desktop app → Plugins → MCPs | local | no | `~/.codex/config.toml` — **dead end** |
| Gemini **Spark** | remote (URL) | **yes** | the Google **account** |

The pattern that explains everything: **config stored on an account follows the user to any
device; config stored in a file on a laptop never does.** When someone asks why their phone
doesn't see it, this is almost always the answer.

---

## Claude — web, desktop, mobile, Cowork

One connector per Claude **account** covers all four surfaces. Adding it in the desktop app
puts it on the account, and the mobile app picks it up on next sign-in — verified.

**Settings → Connectors → Add ⌄ → Add custom connector**

- **Name:** anything, e.g. `Trello MCP`
- **URL:** the path-secret URL
- **Authentication:** `None` — Claude probes the server and usually auto-detects this
- **Request headers:** empty
- **Add**

Then enable it per chat: **+** → Connectors → toggle on. This step is easy to miss and the
tools simply don't appear without it. The toggle is per-device, so it needs one tap on the
phone too even though the connector is already there.

**The more secure variant:** this dialog also offers **Request headers**. Using the short
`/mcp` URL plus a header `authorization: Bearer <MCP_SECRET>` is better, because Claude stores
header values write-only ("never shown again") while the URL form leaves the secret visible in
the connectors list forever — which is exactly how it ends up in a screenshot. Prefer the
header form when the dialog offers it; fall back to the URL form when it doesn't.

Multiple accounts: same URL, same secret, added once per account. Nothing to redeploy.

---

## ChatGPT — use the web Plugin, not the desktop app

**This is the one that trips people up.** The ChatGPT desktop app has its own
Plugins → MCPs screen offering STDIO and Streamable HTTP. Both were tried; neither exposed the
tools to the chat, and either way it writes to `~/.codex/config.toml` — a local file that can
never reach a phone. Skip it.

The route that works is a **Plugin created on chatgpt.com in a browser**:

1. **Settings → Security and login → Developer mode** → on (flagged "elevated risk"; expected)
2. **Settings → Plugins → New Plugin** (the `+`)
3. **Name:** `Trello MCP`, description optional
4. **Connection:** `Server URL` (not Tunnel)
5. **URL:** the path-secret URL — ignore the `/sse` placeholder, `/mcp` is correct
6. **Authentication:** change from **OAuth** to **None**. Leaving it on OAuth is why every
   other attempt fails
7. Tick **"I understand and want to continue"**
8. **Create**

Verified: this reaches the ChatGPT **phone app and the desktop app**, despite OpenAI
documenting Developer Mode as web-only. Set it up once on the web and it propagates.

Available on Plus. Sources disagree about whether write actions work on Plus versus
Business/Enterprise — have the user create a test card rather than predicting it.

---

## Gemini

**The custom MCP lives under Gemini "Spark" (beta), not regular Gemini chat.** This catches
people out — the app connects successfully, then regular Gemini says it has no Trello access,
because only Spark exposes custom MCP tools. Go to Spark.

**Settings → Connected Apps → Custom apps**, or the "Custom apps" section with
*"Add a custom app link to get started"*.

1. Paste the path-secret URL, click **Next**
2. Leave **Client ID** and **Client secret** empty — the server doesn't speak OAuth
3. Confirm; the tool list appears (23 functions) as a good sign
4. Toggle the app on

Gemini has no request-header field, so the path-secret URL is the only option here.
Verified: this reaches the Gemini phone app.

---

## Claude Code

```bash
claude mcp add trello --scope user -- /absolute/path/to/trello-mcp-wrapper
```

`--scope user` writes to `~/.claude.json`, which is per-OS-user, so every project and every
Claude Code instance on that machine picks it up — including a second instance running under a
different Claude account, since MCP config is not account-scoped. Verify with `claude mcp list`.

## Cursor

`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "trello": { "command": "/absolute/path/to/trello-mcp-wrapper" } } }
```

Restart Cursor.

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.trello]
command = "/absolute/path/to/trello-mcp-wrapper"
startup_timeout_sec = 30.0
```

Restart Codex. When editing this file programmatically, diff against a backup afterwards —
it's long, often hand-maintained, and an awk/sed insert can silently damage unrelated tables.

Note this file frequently already contains API keys in plaintext under `[mcp_servers.*.env]`.
Worth mentioning to the user as a thing the keychain-wrapper pattern would fix, but don't
change it uninvited — it's working configuration for other tools.

---

## Verifying a connection

Ask the client: *"Which Trello workspaces do you see?"*

- **All workspaces** → working
- **One workspace** → it answered from the official Trello connector; remove that connector
- **"not connected" / "not installed"** → the per-chat toggle is off, or the app needs a full
  restart (`Cmd+Q`, not just closing the window), or it's a client that was never actually
  reachable, like the ChatGPT desktop MCP screen

For a write test, have it create a card on a scratch board. Reading working does not prove
writing works — some surfaces are read-limited.
