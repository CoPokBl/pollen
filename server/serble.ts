// Thin client for the parts of the Serble API Pollen uses.
import { config } from "./config.ts";

export class SerbleError extends Error {
  constructor(public status: number, public body: string, public path: string) {
    super(`Serble ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

/** Serble returns a mix of camelCase and PascalCase JSON; normalise to camelCase. */
function camel(x: unknown): any {
  if (Array.isArray(x)) return x.map(camel);
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) o[k.charAt(0).toLowerCase() + k.slice(1)] = camel(v);
    return o;
  }
  return x;
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  // Serble rejects body-less POSTs, so always send at least an empty object.
  if (init.method === "POST" && init.body === undefined) init = { ...init, body: "{}" };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body) headers["Content-Type"] = "application/json";
  // Serble's own header rather than Authorization: it names the credential type explicitly, and
  // proxies that manage Authorization for api.serble.net (e.g. a dev sandbox) leave it alone.
  headers.SerbleAuth = init.token ? `App ${init.token}` : `ApiKey ${config.apiKey}`;
  const res = await fetch(config.serbleApi + path, { ...init, headers: { ...headers, ...(init.headers as any) }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new SerbleError(res.status, text, path);
  if (!text) return undefined as T;
  try {
    let parsed = JSON.parse(text);
    // Some endpoints return a JSON string containing JSON.
    if (typeof parsed === "string" && /^[\[{]/.test(parsed)) parsed = JSON.parse(parsed);
    return camel(parsed) as T;
  } catch {
    return text as T;
  }
}

export interface SerbleItem {
  id: string; readableId?: string; ownerType: string; ownerId: string; creatorAppId: string;
  dateCreated: string; name: string; description?: string; iconUrl?: string;
}
export interface Proposal {
  proposalId: string; status: string; appId: string; userId: string; amount: number;
  offeredItemIds: string[]; requestedItemIds: string[]; transactionId?: string; failureReason?: string;
  expiresAt: string;
}

export const serble = {
  itemFee: () => call<{ coins: string; raw: number }>("/api/v1/items/fee"),
  createItem: (body: { name: string; description?: string; iconUrl?: string }) =>
    call<SerbleItem>("/api/v1/items", { method: "POST", body: JSON.stringify(body) }),
  appBalance: () => call<{ coins: number }>("/api/v1/balance"),
  createProposal: (body: {
    user: string; amount?: string; offeredItemIds?: string[]; requestedItemIds?: string[];
    description?: string; redirectUri?: string;
  }) => {
    // Amount is a raw ulong; send it as a JSON number literal without going through a JS double.
    const { amount, ...rest } = body;
    const json = JSON.stringify(rest).replace(/}$/, `,"amount":${/^\d+$/.test(amount ?? "") ? amount : "0"}}`);
    return call<{ proposal: Proposal; consentUrl: string }>("/api/v1/transactions/proposals", { method: "POST", body: json });
  },
  getProposal: (id: string) => call<Proposal>(`/api/v1/transactions/proposals/${encodeURIComponent(id)}`),
  cancelProposal: (id: string) => call<Proposal>(`/api/v1/transactions/proposals/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  // ---- with a user's OAuth token
  userBalance: (token: string) => call<{ coins: number }>("/api/v1/balance", { token }),
  userInventory: (token: string, creatorApp: string, offset = 0) =>
    call<SerbleItem[]>(`/api/v1/inventory?limit=200&offset=${offset}&creatorApp=${encodeURIComponent(creatorApp)}`, { token }),
  account: (token: string) => call<{ id: string; username: string }>("/api/v1/account", { token }),

  // ---- OAuth
  // Serble's legacy OAuth: its access tokens work across the API (the OIDC ones only reach userinfo).
  exchangeCode: (code: string) => tokenRequest("/api/v1/oauth/token/refresh2", { grant_type: "authorization_code", code }),
  refresh: (refreshToken: string) => tokenRequest("/api/v1/oauth/token/access2", { grant_type: "authorization_code", refresh_token: refreshToken }),
};

async function tokenRequest(path: string, params: Record<string, string>) {
  const body = new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.clientSecret });
  const res = await fetch(config.serbleApi + path, {
    method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new SerbleError(res.status, text, path);
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string };
}
