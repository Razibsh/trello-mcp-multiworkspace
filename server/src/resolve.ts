/**
 * Name resolution: the difference between a Trello MCP that works and one
 * that quietly writes to the wrong board.
 *
 * The model says "SHYFT > Development > Backlog"; Trello wants three opaque
 * 24-char ids. We resolve names in tiers (exact -> prefix -> substring) and
 * REFUSE on ambiguity rather than guessing, returning the candidates so the
 * model can ask a follow-up question instead of inventing an answer.
 */

import type { Board, List, TrelloClient, Workspace } from "./trello.js";

export class AmbiguousNameError extends Error {
  constructor(kind: string, query: string, readonly candidates: string[]) {
    super(
      `Ambiguous ${kind} "${query}". Candidates: ${candidates.join(", ")}. ` +
        `Re-run with the exact name.`,
    );
    this.name = "AmbiguousNameError";
  }
}

export class NotFoundError extends Error {
  constructor(kind: string, query: string, readonly available: string[]) {
    super(
      `No ${kind} matching "${query}". Available: ${
        available.length ? available.join(", ") : "(none)"
      }`,
    );
    this.name = "NotFoundError";
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Tiered match. An exact hit always wins outright, even if other entries
 * would also match as a prefix or substring — otherwise a board named
 * "Marketing" could be shadowed by "Marketing Archive".
 */
export function matchByName<T>(
  items: T[],
  query: string,
  nameOf: (item: T) => string[],
  kind: string,
): T {
  const q = norm(query);
  const names = items.flatMap(nameOf);

  const exact = items.filter((i) => nameOf(i).some((n) => norm(n) === q));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new AmbiguousNameError(kind, query, exact.flatMap(nameOf));
  }

  const prefix = items.filter((i) => nameOf(i).some((n) => norm(n).startsWith(q)));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new AmbiguousNameError(kind, query, prefix.flatMap(nameOf));
  }

  const sub = items.filter((i) => nameOf(i).some((n) => norm(n).includes(q)));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) {
    throw new AmbiguousNameError(kind, query, sub.flatMap(nameOf));
  }

  throw new NotFoundError(kind, query, names);
}

const looksLikeId = (s: string) => /^[0-9a-f]{24}$/i.test(s.trim());

interface CacheEntry<T> {
  value: T;
  at: number;
}

/**
 * Short-lived cache. Board and list structure changes rarely; card data is
 * never cached, so a stale entry can misroute a lookup for at most TTL_MS
 * and never returns stale card content.
 */
export class Resolver {
  private static readonly TTL_MS = 60_000;
  private workspaceCache?: CacheEntry<Workspace[]>;
  private boardCache?: CacheEntry<Board[]>;
  private listCache = new Map<string, CacheEntry<List[]>>();

  constructor(private readonly client: TrelloClient) {}

  private fresh<T>(entry: CacheEntry<T> | undefined): T | undefined {
    if (!entry) return undefined;
    return Date.now() - entry.at < Resolver.TTL_MS ? entry.value : undefined;
  }

  async workspaces(): Promise<Workspace[]> {
    const hit = this.fresh(this.workspaceCache);
    if (hit) return hit;
    const value = await this.client.workspaces();
    this.workspaceCache = { value, at: Date.now() };
    return value;
  }

  async boards(): Promise<Board[]> {
    const hit = this.fresh(this.boardCache);
    if (hit) return hit;
    const value = await this.client.boards();
    this.boardCache = { value, at: Date.now() };
    return value;
  }

  async lists(idBoard: string): Promise<List[]> {
    const hit = this.fresh(this.listCache.get(idBoard));
    if (hit) return hit;
    const value = await this.client.lists(idBoard);
    this.listCache.set(idBoard, { value, at: Date.now() });
    return value;
  }

  async workspace(query: string): Promise<Workspace> {
    const all = await this.workspaces();
    if (looksLikeId(query)) {
      const byId = all.find((w) => w.id === query.trim());
      if (byId) return byId;
    }
    return matchByName(all, query, (w) => [w.displayName, w.name], "workspace");
  }

  /**
   * Board lookup is scoped to a workspace when one is given. Without a scope
   * an ambiguous board name across two workspaces raises rather than picking
   * one — which is exactly the cross-workspace mistake this server exists to
   * make impossible.
   */
  async board(query: string, workspaceQuery?: string): Promise<Board> {
    let candidates = await this.boards();
    if (workspaceQuery) {
      const ws = await this.workspace(workspaceQuery);
      candidates = candidates.filter((b) => b.idOrganization === ws.id);
    }
    if (looksLikeId(query)) {
      const byId = candidates.find((b) => b.id === query.trim());
      if (byId) return byId;
    }
    return matchByName(candidates, query, (b) => [b.name], "board");
  }

  async list(query: string, idBoard: string): Promise<List> {
    const all = await this.lists(idBoard);
    if (looksLikeId(query)) {
      const byId = all.find((l) => l.id === query.trim());
      if (byId) return byId;
    }
    return matchByName(all, query, (l) => [l.name], "list");
  }

  /** Resolve a workspace/board/list triple in one call. */
  async target(input: { workspace?: string; board: string; list?: string }): Promise<{
    workspace?: Workspace;
    board: Board;
    list?: List;
  }> {
    const board = await this.board(input.board, input.workspace);
    const workspace = board.idOrganization
      ? (await this.workspaces()).find((w) => w.id === board.idOrganization)
      : undefined;
    const list = input.list ? await this.list(input.list, board.id) : undefined;
    return { workspace, board, list };
  }

  /** Human-readable "Workspace > Board" label for a board id. */
  async label(idBoard: string): Promise<string> {
    const board = (await this.boards()).find((b) => b.id === idBoard);
    if (!board) return idBoard;
    const ws = board.idOrganization
      ? (await this.workspaces()).find((w) => w.id === board.idOrganization)
      : undefined;
    return ws ? `${ws.displayName} > ${board.name}` : board.name;
  }
}
