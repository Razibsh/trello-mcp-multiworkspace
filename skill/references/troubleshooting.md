# Troubleshooting and maintenance

## Symptom → cause

| Symptom | Cause | Fix |
|---|---|---|
| Connector fails to add; client tries to sign in | Bare `/mcp` URL with no credential → 401 → client attempts OAuth | Use the path-secret URL, or the short URL plus `Authorization: Bearer` header |
| "You have one workspace" | The official Trello connector answered, not this one | Remove the official Trello connector from that client |
| `verify` lists one workspace | Token created with default/narrow scope | Regenerate with `scope=read,write&expiration=never` |
| Client says "not connected" though it's installed | Per-chat toggle off, or app not fully restarted | Toggle in **+** → Connectors; `Cmd+Q` and reopen |
| Smoke test: "missing tools", empty handshake | `dist/` doesn't exist | `npm run build` first |
| Worked yesterday, all remote clients now 401 | `MCP_SECRET` was rotated | Re-paste the new URL in every remote client |
| Tools listed but every call errors | Trello token revoked or expired | Re-run `npm run verify` to confirm, then regenerate |
| Writes fail, reads fine | `TRELLO_READ_ONLY=true`, or a client tier that is read-only | Check the Worker var; on ChatGPT Plus, write support is genuinely uncertain |

## Rotating `MCP_SECRET`

Do this immediately if the URL appears in a screenshot, a shared doc, or a transcript. Takes
about a minute. It does **not** touch the Trello token, boards or cards, and local clients are
unaffected because they read the keychain rather than the URL.

```bash
NEW=$(openssl rand -hex 32); security add-generic-password -a "$USER" -s trello-mcp-secret -w "$NEW" -U; unset NEW
cd /path/to/trello-mcp
security find-generic-password -s trello-mcp-secret -w | tr -d '\n' | npx wrangler secret put MCP_SECRET
```

**Then confirm the old secret is actually dead** — this is the step people skip, and without
it you've assumed a fix rather than verified one:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<worker>/<OLD_SECRET>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
```

Must print `401`. Then re-paste the new URL into every remote client. `wrangler secret put`
takes effect without a redeploy.

Rotate *before* connecting many clients, not after — the cost of rotation scales with how many
remote clients are configured.

## Regenerating the Trello token

For a lost token, or to revoke AI access to Trello entirely.

1. Revoke the old one: trello.com → Settings → Applications → remove the app
2. Rebuild the authorize URL — the scope parameters are the whole point:
   ```bash
   KEY=$(security find-generic-password -s trello-api-key -w | tr -d '\n')
   open "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Trello%20MCP&key=$KEY"
   ```
3. Store it: `security add-generic-password -a "$USER" -s trello-token -U -w`
4. Push and verify:
   ```bash
   security find-generic-password -s trello-token -w | tr -d '\n' | npx wrangler secret put TRELLO_TOKEN
   TRELLO_API_KEY=$(security find-generic-password -s trello-api-key -w) \
   TRELLO_TOKEN=$(security find-generic-password -s trello-token -w) npm run verify
   ```

`verify` must show every expected workspace. One workspace means step 2 produced a narrow
token again.

## Rebuilding from nothing

If the machine is lost. Nothing here is unrecoverable — the Worker and all Trello data live
elsewhere.

1. Copy `assets/server/` to a working directory; `npm install && npm run build`
2. API key: re-read from trello.com/power-ups/admin → the app → API key → keychain
3. Token: regenerate as above
4. Secret: `openssl rand -hex 32` → keychain
5. `npx wrangler login`, `wrangler secret put` ×3, `npx wrangler deploy`
6. Re-add every client from `clients.md`

Keep the Worker **name** the same to keep the same `*.workers.dev` URL — otherwise every
remote client needs re-pasting for that reason alone.

## Health checks

```bash
curl -s https://<worker>/health                      # -> ok
node scripts/smoke.mjs                               # offline: handshake + 14 tools (build first)
npm run verify                                       # live, read-only: workspaces + boards
```

`verify` only touches GET endpoints — safe to run against a production Trello at any time.

## Known limits

- **Custom Fields are not exposed.** Paid Trello feature; labels are the workaround. Adding
  support means extending `TrelloClient` first, then surfacing tools.
- **No attachments, no board creation.** Same pattern to add.
- 60s cache on workspace/board/list structure; card data is never cached, so task state is
  always fresh.
- **Preview URLs are on by default**, so each deployed version also gets its own public URL.
  Auth is enforced on all of them so it isn't a hole, but it is extra surface — set
  `"preview_urls": false` in `wrangler.jsonc` and redeploy to remove it.
- `TRELLO_ALLOWED_WORKSPACES` filters only the list tools. `get_card`/`list_cards` accept raw
  ids without re-checking, so treat it as tidiness, not a security boundary. Use
  `TRELLO_READ_ONLY=true` when a real guard is needed.
- Trello rate limits are 300 req/10s per key and 100 req/10s per token. The client retries
  429s with backoff rather than surfacing them.
