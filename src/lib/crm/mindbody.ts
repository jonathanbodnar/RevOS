/**
 * Mindbody connector, Public API v6 (built to the docs; RevOS has no Mindbody
 * developer key yet, so it has never run against a live site).
 *
 * Needs RevOS's own developer account:
 *   MINDBODY_API_KEY          developer API key (sent as Api-Key)
 *   MINDBODY_SOURCE_NAME      the developer account's source name
 *   MINDBODY_SOURCE_PASSWORD  its source password
 * Until all three are set the card says Mindbody isn't available yet.
 *
 * Flow:
 *  1. The clinic enters its Site ID. We ask Mindbody for an activation link
 *     and code (GET /site/activationcode). The owner opens the link and logs
 *     in (or enters the code under Manager Tools > Mindbody Add Ons > API
 *     Integrations) to approve RevOS.
 *  2. "Check": Mindbody creates staff credentials for the integration
 *     ("_" + source name, same password) when the site is approved. We issue
 *     a staff token with them (POST /usertoken/issue) and read one client to
 *     prove access. No clinic password is ever asked for or stored.
 *  3. Syncs page GET /client/clients (200 per page, request.lastModifiedDate
 *     for later syncs) with that token.
 *
 * Before turning this on: Mindbody's API terms (§8) limit caching Mindbody
 * data past 48 hours, which conflicts with keeping clients as leads. Get
 * Mindbody's written OK first (docs/call-center-import.md).
 */
import type { LeadRecord } from "../call-center/import";
import { arr, http, obj, requestJson, retryAfterMs, str } from "./http";
import {
  CrmError,
  decodeCursor,
  encodeCursor,
  type ConnectOutcome,
  type CrmAdapter,
  type Credentials,
  type FetchOptions,
  type FetchResult,
} from "./types";

export const MINDBODY_BASE = "https://api.mindbodyonline.com/public/v6";
export const MINDBODY_PAGE_SIZE = 200;

function config() {
  return {
    apiKey: process.env.MINDBODY_API_KEY?.trim() || "",
    sourceName: process.env.MINDBODY_SOURCE_NAME?.trim() || "",
    sourcePassword: process.env.MINDBODY_SOURCE_PASSWORD || "",
  };
}

function unavailableReason(): string | null {
  const c = config();
  if (!c.apiKey || !c.sourceName || !c.sourcePassword) {
    return "Mindbody isn't available yet. RevOS is still setting up its Mindbody access. Upload a spreadsheet for now.";
  }
  return null;
}

function headers(siteId: string, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Api-Key": config().apiKey,
    SiteId: siteId,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function errorCode(body: unknown): string | null {
  return str(obj(obj(body).Error).Code);
}

async function call(
  method: "GET" | "POST",
  path: string,
  siteId: string,
  opts: { query?: [string, string][]; body?: unknown; token?: string } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${MINDBODY_BASE}${path}`);
  for (const [k, v] of opts.query ?? []) url.searchParams.append(k, v);
  const init: RequestInit = {
    method,
    headers: headers(siteId, opts.token),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };
  let res = await requestJson("Mindbody", url.toString(), init);
  if (res.status === 429) {
    await http.sleep(retryAfterMs(res.headers));
    res = await requestJson("Mindbody", url.toString(), init);
  }
  if (res.status < 400) return obj(res.body);
  const code = errorCode(res.body);
  if (res.status === 429 || code === "TooManyRequests") {
    throw new CrmError("Mindbody is busy right now. Try again in a minute.", "rate");
  }
  if (code === "InvalidSiteId") throw new CrmError("Mindbody doesn't recognize that Site ID.", "input");
  if (code === "DeniedAccess" || code === "InvalidUserCredentials" || code === "StaffMemberNotFound" || res.status === 401 || res.status === 403) {
    throw new CrmError(
      "Mindbody hasn't approved RevOS for this site yet. The owner needs to open the approval link and log in.",
      "pending",
    );
  }
  if (code === "SQLDBMaintenance") throw new CrmError("Mindbody is down for maintenance. Try again later.", "upstream");
  throw new CrmError(`Mindbody returned an error (${res.status}). Try again later.`, "upstream");
}

function cleanSiteId(v: string | undefined): string {
  const id = (v ?? "").trim();
  if (!/^-?\d{1,10}$/.test(id)) {
    throw new CrmError("Enter your Mindbody Site ID (numbers only). It's in your Mindbody account settings.", "input");
  }
  return id;
}

/** A staff token for the integration's auto-created "_SourceName" login. */
async function issueToken(siteId: string): Promise<string> {
  const c = config();
  const body = await call("POST", "/usertoken/issue", siteId, {
    body: { Username: `_${c.sourceName}`, Password: c.sourcePassword },
  });
  const token = str(body.AccessToken);
  if (!token) throw new CrmError("Mindbody didn't return a sign-in token. Try again later.", "upstream");
  return token;
}

async function siteName(siteId: string): Promise<string | null> {
  const body = await call("GET", "/site/sites", siteId, { query: [["request.siteIds[0]", siteId]] });
  return str(obj(arr(body.Sites)[0]).Name);
}

async function connect(input: Record<string, string>, pending: Credentials | null): Promise<ConnectOutcome> {
  const reason = unavailableReason();
  if (reason) throw new CrmError(reason, "unavailable");

  if (input.action === "check") {
    if (!pending?.siteId) throw new CrmError("Start again and enter your Site ID.", "input");
    const siteId = pending.siteId;
    const token = await issueToken(siteId);
    // Prove we can read clients, not just sign in.
    await call("GET", "/client/clients", siteId, { token, query: [["request.limit", "1"]] });
    const name = (await siteName(siteId)) ?? `Site ${siteId}`;
    return { status: "connected", credentials: { siteId }, accountLabel: name, externalId: siteId };
  }

  const siteId = input.action === "resume" && pending?.siteId ? pending.siteId : cleanSiteId(input.siteId);
  const body = await call("GET", "/site/activationcode", siteId);
  return {
    status: "pending",
    credentials: { siteId },
    accountLabel: `Site ${siteId}`,
    externalId: siteId,
    step: { kind: "approve", url: str(body.ActivationLink), code: str(body.ActivationCode) },
  };
}

function clientRecord(c: unknown): LeadRecord {
  const o = obj(c);
  const stage = str(obj(o.ProspectStage).Description);
  return {
    externalId: str(o.UniqueId) ?? str(o.Id),
    firstName: str(o.FirstName),
    lastName: str(o.LastName),
    email: str(o.Email),
    phones: [str(o.MobilePhone), str(o.HomePhone), str(o.WorkPhone)],
    // A prospect's stage reads best as a status ("Prospect" otherwise);
    // members carry their membership status (Active, Non-Member, …).
    status: o.IsProspect === true ? (stage ?? "Prospect") : str(o.Status),
  };
}

async function fetchLeads(creds: Credentials, opts: FetchOptions): Promise<FetchResult> {
  const reason = unavailableReason();
  if (reason) throw new CrmError(reason, "unavailable");
  const siteId = creds.siteId;
  if (!siteId) throw new CrmError("Connect Mindbody again.", "auth");
  const cur = decodeCursor(opts.cursor);
  const start = typeof cur?.o === "number" && cur.o >= 0 && cur.o <= 10_000_000 ? Math.floor(cur.o) : 0;
  const since =
    typeof cur?.s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cur.s)
      ? cur.s
      : cur
        ? null
        : opts.since
          ? opts.since.toISOString().slice(0, 10)
          : null;

  const token = await issueToken(siteId);
  const records: LeadRecord[] = [];
  let offset = start;
  let more = true;
  while (more && records.length < opts.limit) {
    const limit = Math.min(MINDBODY_PAGE_SIZE, opts.limit - records.length);
    const query: [string, string][] = [
      ["request.limit", String(limit)],
      ["request.offset", String(offset)],
    ];
    if (since) query.push(["request.lastModifiedDate", since]);
    const body = await call("GET", "/client/clients", siteId, { token, query });
    const clients = arr(body.Clients);
    for (const c of clients) records.push(clientRecord(c));
    offset += clients.length;
    const total = Number(obj(body.PaginationResponse).TotalResults);
    more = clients.length >= limit && (!Number.isFinite(total) || offset < total);
  }
  return { records, startIndex: start, nextCursor: more ? encodeCursor({ o: offset, s: since }) : null };
}

export const mindbody: CrmAdapter = {
  provider: "mindbody",
  label: "Mindbody",
  unavailableReason,
  connectFields: [
    {
      name: "siteId",
      label: "Site ID",
      type: "text",
      placeholder: "e.g. 123456",
      help: "Your Mindbody Site ID. We'll give you a link for the account owner to approve RevOS.",
    },
  ],
  connect,
  fetchLeads,
};
