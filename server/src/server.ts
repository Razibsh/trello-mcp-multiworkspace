/**
 * Transport-agnostic MCP server definition.
 *
 * Both entry points (stdio for Codex / Claude Code / Gemini CLI, and the
 * Cloudflare Worker for Claude.ai) build the same server from here, so the
 * tool surface can never drift between them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AmbiguousNameError,
  NotFoundError,
  Resolver,
} from "./resolve.js";
import { TrelloClient, TrelloError, type Card, type TrelloConfig } from "./trello.js";

export const SERVER_NAME = "trello-mcp";
export const SERVER_VERSION = "1.0.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [
    { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
  ],
});

const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Turns resolution and API failures into messages the model can act on.
 * An ambiguous board name should prompt a clarifying question, not a retry
 * loop, so the candidate list is included verbatim.
 */
function toolError(err: unknown): ToolResult {
  if (err instanceof AmbiguousNameError || err instanceof NotFoundError) {
    return fail(err.message);
  }
  if (err instanceof TrelloError) {
    if (err.status === 401 || err.status === 403) {
      return fail(
        "Trello rejected the credentials or denied access to that resource. " +
          "Check TRELLO_API_KEY / TRELLO_TOKEN, and that the token still has access to this board.",
      );
    }
    return fail(err.message);
  }
  return fail(err instanceof Error ? err.message : String(err));
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}

export function createServer(config: TrelloConfig): McpServer {
  const client = new TrelloClient(config);
  const resolver = new Resolver(client);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Trello across ALL of this user's workspaces. Address boards and lists by name " +
        "(e.g. workspace 'SHYFT', board 'Development', list 'Backlog') — ids are optional. " +
        "If a name is ambiguous the tool returns the candidates: ask the user which one " +
        "rather than guessing. Use my_tasks for 'what do I need to do' questions; it spans " +
        "every workspace at once.",
    },
  );

  /** Enrich a card with the human-readable board path and a clickable URL. */
  const decorate = async (card: Card) => ({
    id: card.id,
    name: card.name,
    board: await resolver.label(card.idBoard),
    due: card.due,
    dueComplete: card.dueComplete,
    url: card.shortUrl || card.url,
    desc: card.desc ? card.desc.slice(0, 500) : "",
  });

  // ---------------------------------------------------------------- read

  server.registerTool(
    "list_workspaces",
    {
      title: "List Trello workspaces",
      description:
        "List every Trello workspace this account can see (subject to the server's allowlist). " +
        "Start here when you do not know which workspaces exist.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const ws = await resolver.workspaces();
        return ok(
          ws.map((w) => ({ id: w.id, name: w.displayName, slug: w.name })),
        );
      }),
  );

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description:
        "List open boards, optionally narrowed to one workspace by name. " +
        "Returns each board with the workspace it belongs to.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace name to filter by. Omit to list boards across all workspaces."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace }) =>
      guard(async () => {
        let boards = await resolver.boards();
        if (workspace) {
          const ws = await resolver.workspace(workspace);
          boards = boards.filter((b) => b.idOrganization === ws.id);
        }
        const workspaces = await resolver.workspaces();
        return ok(
          boards.map((b) => ({
            id: b.id,
            name: b.name,
            workspace:
              workspaces.find((w) => w.id === b.idOrganization)?.displayName ?? "(personal)",
            url: b.shortUrl || b.url,
          })),
        );
      }),
  );

  server.registerTool(
    "get_board",
    {
      title: "Get board detail",
      description:
        "Get one board's lists, labels and members. Call this before creating a card " +
        "on an unfamiliar board so you use a list name that actually exists.",
      inputSchema: {
        board: z.string().describe("Board name or id."),
        workspace: z
          .string()
          .optional()
          .describe("Workspace name, to disambiguate boards with the same name."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ board, workspace }) =>
      guard(async () => {
        const target = await resolver.target({ board, workspace });
        const [lists, labels, members] = await Promise.all([
          resolver.lists(target.board.id),
          client.labels(target.board.id),
          client.boardMembers(target.board.id),
        ]);
        return ok({
          board: target.board.name,
          workspace: target.workspace?.displayName ?? "(personal)",
          url: target.board.shortUrl || target.board.url,
          lists: lists.map((l) => l.name),
          labels: labels.filter((l) => l.name).map((l) => `${l.name} (${l.color})`),
          members: members.map((m) => `${m.fullName} (@${m.username})`),
        });
      }),
  );

  server.registerTool(
    "my_tasks",
    {
      title: "My tasks across all workspaces",
      description:
        "Every open card assigned to you, across EVERY workspace and board at once. " +
        "This is the tool for 'what do I need to do', 'what is due this week', or any " +
        "cross-project prioritisation question. Optionally filter by a due-date window.",
      inputSchema: {
        due_within_days: z
          .number()
          .int()
          .min(0)
          .max(365)
          .optional()
          .describe("Only cards due within this many days. Omit for all assigned cards."),
        include_undated: z
          .boolean()
          .optional()
          .describe("When filtering by due date, also include cards with no due date. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ due_within_days, include_undated }) =>
      guard(async () => {
        const cards = await client.myCards();
        const allowedBoards = new Set((await resolver.boards()).map((b) => b.id));
        let filtered = cards.filter((c) => !c.closed && allowedBoards.has(c.idBoard));

        if (due_within_days !== undefined) {
          const cutoff = Date.now() + due_within_days * 86_400_000;
          filtered = filtered.filter((c) => {
            if (!c.due) return include_undated === true;
            return new Date(c.due).getTime() <= cutoff;
          });
        }

        filtered.sort((a, b) => {
          if (!a.due && !b.due) return 0;
          if (!a.due) return 1;
          if (!b.due) return -1;
          return new Date(a.due).getTime() - new Date(b.due).getTime();
        });

        const decorated = await Promise.all(filtered.map(decorate));
        return ok({ count: decorated.length, cards: decorated });
      }),
  );

  server.registerTool(
    "search_cards",
    {
      title: "Search cards",
      description:
        "Full-text search across cards. Searches every workspace by default; narrow with " +
        "workspace or board when the user names one.",
      inputSchema: {
        query: z.string().min(1).describe("Search text."),
        workspace: z.string().optional().describe("Restrict to one workspace by name."),
        board: z.string().optional().describe("Restrict to one board by name."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results, default 30."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, workspace, board, limit }) =>
      guard(async () => {
        const opts: { idBoards?: string[]; idOrganizations?: string[]; limit?: number } = {
          limit: limit ?? 30,
        };
        if (board) {
          const target = await resolver.target({ board, workspace });
          opts.idBoards = [target.board.id];
        } else if (workspace) {
          const ws = await resolver.workspace(workspace);
          opts.idOrganizations = [ws.id];
        } else {
          // Scope the search to allowlisted boards so excluded workspaces
          // cannot leak in through Trello's global search.
          const boards = await resolver.boards();
          if (config.allowedWorkspaces?.length) {
            opts.idBoards = boards.map((b) => b.id).slice(0, 100);
          }
        }
        const res = await client.search(query, opts);
        const cards = (res.cards ?? []).filter((c) => !c.closed);
        return ok({
          count: cards.length,
          cards: await Promise.all(cards.map(decorate)),
        });
      }),
  );

  server.registerTool(
    "get_card",
    {
      title: "Get card detail",
      description: "Full detail for one card including description and checklists.",
      inputSchema: { card_id: z.string().describe("Card id or short link.") },
      annotations: { readOnlyHint: true },
    },
    async ({ card_id }) =>
      guard(async () => {
        const card = await client.card(card_id);
        const checklists = await client.checklists(card.id);
        return ok({
          ...(await decorate(card)),
          desc: card.desc,
          checklists: checklists.map((cl) => ({
            id: cl.id,
            name: cl.name,
            items: cl.checkItems.map((i) => ({
              id: i.id,
              name: i.name,
              done: i.state === "complete",
            })),
          })),
        });
      }),
  );

  server.registerTool(
    "list_cards",
    {
      title: "List cards on a board or list",
      description:
        "All open cards on a board, or on one list within it. Use this to read a " +
        "board's current state rather than searching.",
      inputSchema: {
        board: z.string().describe("Board name or id."),
        workspace: z.string().optional().describe("Workspace name, to disambiguate."),
        list: z.string().optional().describe("List name. Omit for the whole board."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ board, workspace, list }) =>
      guard(async () => {
        const target = await resolver.target({ board, workspace, list });
        const cards = target.list
          ? await client.listCards(target.list.id)
          : await client.boardCards(target.board.id);
        const open = cards.filter((c) => !c.closed);
        const lists = await resolver.lists(target.board.id);
        return ok({
          board: target.board.name,
          workspace: target.workspace?.displayName ?? "(personal)",
          count: open.length,
          cards: open.map((c) => ({
            id: c.id,
            name: c.name,
            list: lists.find((l) => l.id === c.idList)?.name ?? c.idList,
            due: c.due,
            url: c.shortUrl || c.url,
          })),
        });
      }),
  );

  if (client.readOnly) return server;

  // --------------------------------------------------------------- write

  server.registerTool(
    "create_card",
    {
      title: "Create a card",
      description:
        "Create a card by naming the board and list — ids are not required. " +
        "Always confirm the target with the user when the board name is ambiguous.",
      inputSchema: {
        board: z.string().describe("Board name or id."),
        list: z.string().describe("List name on that board, e.g. 'Backlog'."),
        name: z.string().min(1).describe("Card title."),
        workspace: z.string().optional().describe("Workspace name, to disambiguate boards."),
        desc: z.string().optional().describe("Card description (markdown supported)."),
        due: z.string().optional().describe("Due date, ISO 8601, e.g. 2026-09-15T17:00:00Z."),
        labels: z.array(z.string()).optional().describe("Label names that exist on the board."),
        assign_to_me: z.boolean().optional().describe("Assign the card to you. Default false."),
        position: z.enum(["top", "bottom"]).optional().describe("Default bottom."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () => {
        const target = await resolver.target({
          board: input.board,
          workspace: input.workspace,
          list: input.list,
        });
        if (!target.list) throw new Error("List could not be resolved.");

        let idLabels: string[] | undefined;
        if (input.labels?.length) {
          const boardLabels = await client.labels(target.board.id);
          idLabels = input.labels.map((wanted) => {
            const hit = boardLabels.find(
              (l) => l.name && l.name.toLowerCase() === wanted.toLowerCase(),
            );
            if (!hit) {
              throw new NotFoundError(
                "label",
                wanted,
                boardLabels.filter((l) => l.name).map((l) => l.name),
              );
            }
            return hit.id;
          });
        }

        const me = input.assign_to_me ? await client.me() : undefined;
        const card = await client.createCard({
          idList: target.list.id,
          name: input.name,
          desc: input.desc,
          due: input.due,
          idLabels,
          idMembers: me ? [me.id] : undefined,
          pos: input.position,
        });

        return ok({
          created: card.name,
          where: `${target.workspace?.displayName ?? "(personal)"} > ${target.board.name} > ${target.list.name}`,
          id: card.id,
          url: card.shortUrl || card.url,
        });
      }),
  );

  server.registerTool(
    "update_card",
    {
      title: "Update a card",
      description:
        "Change a card's title, description, due date, or completion state. " +
        "Pass only the fields you want to change.",
      inputSchema: {
        card_id: z.string().describe("Card id or short link."),
        name: z.string().optional(),
        desc: z.string().optional(),
        due: z.string().nullable().optional().describe("ISO 8601 date, or null to clear."),
        due_complete: z.boolean().optional().describe("Mark the due date done."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ card_id, name, desc, due, due_complete }) =>
      guard(async () => {
        const card = await client.updateCard(card_id, {
          name,
          desc,
          due,
          dueComplete: due_complete,
        });
        return ok({ updated: card.name, url: card.shortUrl || card.url });
      }),
  );

  server.registerTool(
    "move_card",
    {
      title: "Move a card",
      description:
        "Move a card to another list, optionally on another board. Names are resolved " +
        "the same way as create_card.",
      inputSchema: {
        card_id: z.string().describe("Card id or short link."),
        list: z.string().describe("Destination list name."),
        board: z
          .string()
          .optional()
          .describe("Destination board name. Omit to move within the current board."),
        workspace: z.string().optional().describe("Workspace name, to disambiguate boards."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ card_id, list, board, workspace }) =>
      guard(async () => {
        const current = await client.card(card_id);
        const idBoard = board
          ? (await resolver.board(board, workspace)).id
          : current.idBoard;
        const destination = await resolver.list(list, idBoard);
        const updated = await client.updateCard(card_id, {
          idList: destination.id,
          idBoard: idBoard !== current.idBoard ? idBoard : undefined,
        });
        return ok({
          moved: updated.name,
          to: `${await resolver.label(idBoard)} > ${destination.name}`,
          url: updated.shortUrl || updated.url,
        });
      }),
  );

  server.registerTool(
    "archive_card",
    {
      title: "Archive a card",
      description:
        "Archive a card (Trello's version of done/removed). This is reversible in the " +
        "Trello UI; nothing is permanently deleted. Confirm with the user before archiving.",
      inputSchema: { card_id: z.string().describe("Card id or short link.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ card_id }) =>
      guard(async () => {
        const card = await client.updateCard(card_id, { closed: true });
        return ok({ archived: card.name });
      }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment on a card",
      description: "Add a comment to a card. Useful for logging context or decisions.",
      inputSchema: {
        card_id: z.string().describe("Card id or short link."),
        text: z.string().min(1).describe("Comment body (markdown supported)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ card_id, text }) =>
      guard(async () => {
        await client.addComment(card_id, text);
        return ok({ commented: card_id });
      }),
  );

  server.registerTool(
    "add_checklist",
    {
      title: "Add a checklist to a card",
      description: "Create a checklist on a card and optionally fill it with items.",
      inputSchema: {
        card_id: z.string().describe("Card id or short link."),
        name: z.string().describe("Checklist name, e.g. 'Steps'."),
        items: z.array(z.string()).optional().describe("Items to add, in order."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ card_id, name, items }) =>
      guard(async () => {
        const checklist = await client.createChecklist(card_id, name);
        // Sequential, not parallel: Trello orders check items by insertion.
        for (const item of items ?? []) {
          await client.addCheckItem(checklist.id, item);
        }
        return ok({ checklist: checklist.name, items: items?.length ?? 0 });
      }),
  );

  server.registerTool(
    "set_checklist_item",
    {
      title: "Tick or untick a checklist item",
      description: "Mark a checklist item complete or incomplete.",
      inputSchema: {
        card_id: z.string().describe("Card id or short link."),
        item_id: z.string().describe("Check item id, from get_card."),
        done: z.boolean().describe("true to complete, false to reopen."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ card_id, item_id, done }) =>
      guard(async () => {
        const item = await client.setCheckItemState(
          card_id,
          item_id,
          done ? "complete" : "incomplete",
        );
        return ok({ item: item.name, done });
      }),
  );

  return server;
}

/** Read configuration from a plain env bag (process.env or Worker env). */
export function configFromEnv(env: Record<string, string | undefined>): TrelloConfig {
  return {
    apiKey: env.TRELLO_API_KEY ?? "",
    token: env.TRELLO_TOKEN ?? "",
    allowedWorkspaces: (env.TRELLO_ALLOWED_WORKSPACES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    readOnly: env.TRELLO_READ_ONLY === "true",
  };
}
