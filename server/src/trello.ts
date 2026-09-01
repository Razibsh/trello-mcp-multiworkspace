/**
 * Minimal typed Trello REST client.
 *
 * Auth is sent as an Authorization header rather than query params so the
 * token never lands in a URL, a proxy log, or an error message.
 * Trello rate limits are 300 req/10s per key and 100 req/10s per token,
 * so 429s are retried with backoff instead of surfacing to the model.
 */

export interface TrelloConfig {
  apiKey: string;
  token: string;
  /** Optional allowlist of workspace names or ids. Empty = every workspace. */
  allowedWorkspaces?: string[];
  readOnly?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  displayName: string;
  url?: string;
}

export interface Board {
  id: string;
  name: string;
  idOrganization: string | null;
  closed: boolean;
  url: string;
  shortUrl?: string;
}

export interface List {
  id: string;
  name: string;
  pos: number;
  closed: boolean;
  idBoard: string;
}

export interface Label {
  id: string;
  name: string;
  color: string | null;
}

export interface Member {
  id: string;
  username: string;
  fullName: string;
}

export interface Card {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  dueComplete: boolean;
  closed: boolean;
  idList: string;
  idBoard: string;
  idMembers: string[];
  idLabels: string[];
  labels?: Label[];
  url: string;
  shortUrl: string;
  shortLink?: string;
  dateLastActivity?: string;
}

export interface CheckItem {
  id: string;
  name: string;
  state: "complete" | "incomplete";
  pos: number;
}

export interface Checklist {
  id: string;
  name: string;
  idCard: string;
  checkItems: CheckItem[];
}

export class TrelloError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "TrelloError";
  }
}

const BASE = "https://api.trello.com/1";
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TrelloClient {
  constructor(private readonly config: TrelloConfig) {
    if (!config.apiKey) throw new Error("TRELLO_API_KEY is not set");
    if (!config.token) throw new Error("TRELLO_TOKEN is not set");
  }

  get readOnly(): boolean {
    return this.config.readOnly === true;
  }

  private authHeader(): string {
    return `OAuth oauth_consumer_key="${this.config.apiKey}", oauth_token="${this.config.token}"`;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: this.authHeader(),
            Accept: "application/json",
          },
        });

        // Trello throttles aggressively; back off rather than fail the tool call.
        if (res.status === 429) {
          if (attempt === MAX_RETRIES) {
            throw new TrelloError("Trello rate limit exceeded after retries", 429, path);
          }
          await sleep(2 ** attempt * 500);
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new TrelloError(
            `Trello ${method} ${path} failed (${res.status}): ${body.slice(0, 300)}`,
            res.status,
            path,
          );
        }

        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      } catch (err) {
        lastErr = err;
        // Only retry transport-level failures, never 4xx business errors.
        if (err instanceof TrelloError && err.status !== 429) throw err;
        if (attempt === MAX_RETRIES) break;
        await sleep(2 ** attempt * 500);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // ---------- identity ----------

  me(): Promise<Member> {
    return this.request<Member>("GET", "/members/me", {
      fields: "id,username,fullName",
    });
  }

  // ---------- workspaces ----------

  async workspaces(): Promise<Workspace[]> {
    const all = await this.request<Workspace[]>("GET", "/members/me/organizations", {
      fields: "id,name,displayName,url",
    });
    return this.applyAllowlist(all);
  }

  /**
   * The allowlist is enforced here, in the client, so no tool can reach a
   * workspace the operator excluded even if the model asks for it by id.
   */
  private applyAllowlist(workspaces: Workspace[]): Workspace[] {
    const allow = this.config.allowedWorkspaces;
    if (!allow || allow.length === 0) return workspaces;
    const wanted = allow.map((a) => a.trim().toLowerCase()).filter(Boolean);
    return workspaces.filter(
      (w) =>
        wanted.includes(w.id.toLowerCase()) ||
        wanted.includes(w.name.toLowerCase()) ||
        wanted.includes(w.displayName.toLowerCase()),
    );
  }

  async isWorkspaceAllowed(idOrganization: string | null): Promise<boolean> {
    const allow = this.config.allowedWorkspaces;
    if (!allow || allow.length === 0) return true;
    if (!idOrganization) return false;
    const allowed = await this.workspaces();
    return allowed.some((w) => w.id === idOrganization);
  }

  // ---------- boards ----------

  async boards(): Promise<Board[]> {
    const all = await this.request<Board[]>("GET", "/members/me/boards", {
      fields: "id,name,idOrganization,closed,url,shortUrl",
      filter: "open",
    });
    const allow = this.config.allowedWorkspaces;
    if (!allow || allow.length === 0) return all;
    const allowedIds = new Set((await this.workspaces()).map((w) => w.id));
    return all.filter((b) => b.idOrganization && allowedIds.has(b.idOrganization));
  }

  lists(idBoard: string): Promise<List[]> {
    return this.request<List[]>("GET", `/boards/${idBoard}/lists`, {
      fields: "id,name,pos,closed,idBoard",
      filter: "open",
    });
  }

  labels(idBoard: string): Promise<Label[]> {
    return this.request<Label[]>("GET", `/boards/${idBoard}/labels`, {
      fields: "id,name,color",
    });
  }

  boardMembers(idBoard: string): Promise<Member[]> {
    return this.request<Member[]>("GET", `/boards/${idBoard}/members`, {
      fields: "id,username,fullName",
    });
  }

  // ---------- cards ----------

  private static readonly CARD_FIELDS =
    "id,name,desc,due,dueComplete,closed,idList,idBoard,idMembers,idLabels,url,shortUrl,dateLastActivity";

  boardCards(idBoard: string, limit = 200): Promise<Card[]> {
    return this.request<Card[]>("GET", `/boards/${idBoard}/cards`, {
      fields: TrelloClient.CARD_FIELDS,
      limit,
    });
  }

  listCards(idList: string): Promise<Card[]> {
    return this.request<Card[]>("GET", `/lists/${idList}/cards`, {
      fields: TrelloClient.CARD_FIELDS,
    });
  }

  card(idCard: string): Promise<Card> {
    return this.request<Card>("GET", `/cards/${idCard}`, {
      fields: TrelloClient.CARD_FIELDS,
    });
  }

  /** Open cards assigned to the authenticated member, across every board. */
  myCards(): Promise<Card[]> {
    return this.request<Card[]>("GET", "/members/me/cards", {
      fields: TrelloClient.CARD_FIELDS,
    });
  }

  search(
    query: string,
    opts: { idBoards?: string[]; idOrganizations?: string[]; limit?: number } = {},
  ): Promise<{ cards?: Card[]; boards?: Board[] }> {
    return this.request("GET", "/search", {
      query,
      modelTypes: "cards",
      card_fields: TrelloClient.CARD_FIELDS,
      cards_limit: opts.limit ?? 50,
      partial: true,
      idBoards: opts.idBoards?.length ? opts.idBoards.join(",") : undefined,
      idOrganizations: opts.idOrganizations?.length
        ? opts.idOrganizations.join(",")
        : undefined,
    });
  }

  createCard(input: {
    idList: string;
    name: string;
    desc?: string;
    due?: string;
    idMembers?: string[];
    idLabels?: string[];
    pos?: "top" | "bottom";
  }): Promise<Card> {
    return this.request<Card>("POST", "/cards", {
      idList: input.idList,
      name: input.name,
      desc: input.desc,
      due: input.due,
      idMembers: input.idMembers?.join(","),
      idLabels: input.idLabels?.join(","),
      pos: input.pos ?? "bottom",
    });
  }

  updateCard(
    idCard: string,
    patch: {
      name?: string;
      desc?: string;
      due?: string | null;
      dueComplete?: boolean;
      closed?: boolean;
      idList?: string;
      idBoard?: string;
      idLabels?: string[];
      idMembers?: string[];
      pos?: "top" | "bottom";
    },
  ): Promise<Card> {
    return this.request<Card>("PUT", `/cards/${idCard}`, {
      name: patch.name,
      desc: patch.desc,
      due: patch.due === null ? "null" : patch.due,
      dueComplete: patch.dueComplete,
      closed: patch.closed,
      idList: patch.idList,
      idBoard: patch.idBoard,
      idLabels: patch.idLabels?.join(","),
      idMembers: patch.idMembers?.join(","),
      pos: patch.pos,
    });
  }

  addComment(idCard: string, text: string): Promise<unknown> {
    return this.request("POST", `/cards/${idCard}/actions/comments`, { text });
  }

  // ---------- checklists ----------

  checklists(idCard: string): Promise<Checklist[]> {
    return this.request<Checklist[]>("GET", `/cards/${idCard}/checklists`);
  }

  createChecklist(idCard: string, name: string): Promise<Checklist> {
    return this.request<Checklist>("POST", "/checklists", { idCard, name });
  }

  addCheckItem(idChecklist: string, name: string): Promise<CheckItem> {
    return this.request<CheckItem>("POST", `/checklists/${idChecklist}/checkItems`, {
      name,
    });
  }

  setCheckItemState(
    idCard: string,
    idCheckItem: string,
    state: "complete" | "incomplete",
  ): Promise<CheckItem> {
    return this.request<CheckItem>("PUT", `/cards/${idCard}/checkItem/${idCheckItem}`, {
      state,
    });
  }
}
