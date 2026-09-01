#!/usr/bin/env node
/**
 * Live check against the real Trello API. Run this BEFORE connecting any AI:
 *
 *   TRELLO_API_KEY=... TRELLO_TOKEN=... node scripts/verify.mjs
 *
 * It only reads. Nothing is created, moved or archived.
 */

const key = process.env.TRELLO_API_KEY;
const token = process.env.TRELLO_TOKEN;

if (!key || !token) {
  console.error("Set TRELLO_API_KEY and TRELLO_TOKEN first.");
  process.exit(1);
}

const auth = { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` };

async function get(path, params = {}) {
  const url = new URL("https://api.trello.com/1" + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => console.log(`  FAIL ${m}`);

try {
  console.log("\nTrello credential + scope check\n");

  const me = await get("/members/me", { fields: "id,username,fullName" });
  pass(`authenticated as ${me.fullName} (@${me.username})`);

  const orgs = await get("/members/me/organizations", { fields: "id,name,displayName" });
  pass(`${orgs.length} workspace(s) visible to this token:`);
  for (const o of orgs) console.log(`       - ${o.displayName}  [${o.id}]`);

  if (orgs.length < 2) {
    console.log(
      "\n  note  Only one workspace came back. If you expected more, the token was\n" +
      "        probably generated with a narrower scope — regenerate it.\n",
    );
  }

  const boards = await get("/members/me/boards", {
    fields: "id,name,idOrganization",
    filter: "open",
  });
  pass(`${boards.length} open board(s) across all workspaces:`);
  for (const b of boards) {
    const ws = orgs.find((o) => o.id === b.idOrganization);
    console.log(`       - ${ws ? ws.displayName : "(personal)"} > ${b.name}`);
  }

  const mine = await get("/members/me/cards", { fields: "id,name,due,idBoard" });
  pass(`${mine.length} card(s) currently assigned to you`);

  const search = await get("/search", {
    query: "a",
    modelTypes: "cards",
    cards_limit: "1",
    partial: "true",
  });
  pass(`search endpoint reachable (${(search.cards ?? []).length} sample result)`);

  console.log("\nAll checks passed. This token can see every workspace listed above.\n");
} catch (err) {
  fail(err.message);
  console.log("\nCheck that the token has not expired and was created from the same API key.\n");
  process.exit(1);
}
