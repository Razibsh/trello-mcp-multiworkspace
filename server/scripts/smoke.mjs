#!/usr/bin/env node
/**
 * Offline smoke test: boots the stdio server with dummy credentials and
 * asserts the MCP handshake and the full tool list. No Trello calls.
 */
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/stdio.js"], {
  env: { ...process.env, TRELLO_API_KEY: "dummy", TRELLO_TOKEN: "dummy" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const responses = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) responses.push(JSON.parse(line));
  }
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  },
});

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
}, 300);

setTimeout(() => {
  const init = responses.find((r) => r.id === 1);
  const tools = responses.find((r) => r.id === 2);
  let failed = false;

  if (init?.result?.serverInfo?.name === "trello-mcp") {
    console.log("  ok   handshake:", init.result.serverInfo.name, init.result.serverInfo.version);
  } else {
    console.log("  FAIL handshake", JSON.stringify(init)); failed = true;
  }

  const names = (tools?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "add_checklist", "add_comment", "archive_card", "assign_card", "attach_link", "create_board",
    "create_card", "create_label", "create_list", "get_board", "get_board_activity",
    "get_card", "get_card_comments", "list_boards", "list_cards", "list_workspaces",
    "move_card", "my_tasks", "search_cards", "set_checklist_item", "update_card",
    "update_comment", "update_list",
  ];
  const missing = expected.filter((e) => !names.includes(e));
  if (missing.length === 0) {
    console.log(`  ok   ${names.length} tools registered`);
    for (const n of names) console.log(`       - ${n}`);
  } else {
    console.log("  FAIL missing tools:", missing.join(", ")); failed = true;
  }

  const createCard = (tools?.result?.tools ?? []).find((t) => t.name === "create_card");
  const props = Object.keys(createCard?.inputSchema?.properties ?? {});
  if (props.includes("board") && props.includes("list") && props.includes("workspace")) {
    console.log("  ok   create_card accepts workspace/board/list by name");
  } else {
    console.log("  FAIL create_card schema:", props.join(",")); failed = true;
  }

  child.kill();
  console.log(failed ? "\nSMOKE TEST FAILED\n" : "\nSmoke test passed.\n");
  process.exit(failed ? 1 : 0);
}, 1500);
