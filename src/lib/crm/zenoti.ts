/**
 * Zenoti connector (built to docs.zenoti.com; not yet run against a live account).
 *
 * The clinic creates a backend app in Zenoti (Configuration > Integrations >
 * Apps > Add), generates an API key and pastes it on the card. We check the
 * key by listing centers, the clinic picks its center, and syncs page through
 * that center's guests.
 *
 *  - Base URL https://api.zenoti.com/v1 (US).
 *  - Auth header `Authorization: apikey <key>`.
 *  - GET /v1/centers → { centers: [{ id, code, name, display_name }] }.
 *  - GET /v1/guests?center_id&page&size[&last_updated] → { guests: [...] },
 *    at most 100 per page; we page until a short page.
 *  - 60 calls a minute per Zenoti account (shared with the clinic's other
 *    apps), so calls are spaced and a 429 is retried once after Retry-After.
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

export const ZENOTI_BASE = "https://api.zenoti.com/v1";
export const ZENOTI_PAGE_SIZE = 100;
/** Gap between calls in one sync batch (60 calls/minute account limit). */
export const ZENOTI_CALL_GAP_MS = 1100;

type Center = { id: string; name: string };

function auth(apiKey: string): HeadersInit {
  return { Authorization: `apikey ${apiKey}`, Accept: "application/json" };
}

async function get(apiKey: string, path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`${ZENOTI_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res = await requestJson("Zenoti", url.toString(), { method: "GET", headers: auth(apiKey) });
  if (res.status === 429) {
    await http.sleep(retryAfterMs(res.headers));
    res = await requestJson("Zenoti", url.toString(), { method: "GET", headers: auth(apiKey) });
  }
  if (res.status === 401 || res.status === 403) {
    throw new CrmError(
      "Zenoti didn't accept this API key. Check you copied all of it, and that the app can read guests and centers.",
      "auth",
    );
  }
  if (res.status === 429) throw new CrmError("Zenoti is busy right now. Try again in a minute.", "rate");
  if (res.status >= 400) throw new CrmError(`Zenoti returned an error (${res.status}). Try again later.`, "upstream");
  const body = obj(res.body);
  // Zenoti reports failures in an `error` key (null on success).
  if (body.error) throw new CrmError("Zenoti returned an error. Try again later.", "upstream");
  return body;
}

export async function listCenters(apiKey: string): Promise<Center[]> {
  const body = await get(apiKey, "/centers", { page: "1", size: String(ZENOTI_PAGE_SIZE) });
  const out: Center[] = [];
  for (const c of arr(body.centers)) {
    const o = obj(c);
    const id = str(o.id);
    if (!id) continue;
    out.push({ id, name: str(o.display_name) || str(o.name) || str(o.code) || "Center" });
  }
  return out;
}

function cleanKey(v: string | undefined): string {
  const key = (v ?? "").trim();
  if (!key || key.length > 500 || /\s/.test(key)) {
    throw new CrmError("Paste the API key from Zenoti (Configuration > Integrations > Apps).", "input");
  }
  return key;
}

function connected(apiKey: string, center: Center): ConnectOutcome {
  return { status: "connected", credentials: { apiKey, centerId: center.id }, accountLabel: center.name, externalId: center.id };
}

async function connect(input: Record<string, string>, pending: Credentials | null): Promise<ConnectOutcome> {
  // Second step: the center was picked.
  if (input.centerId) {
    if (!pending?.apiKey) throw new CrmError("Start again and paste the API key.", "input");
    const centers = await listCenters(pending.apiKey);
    const center = centers.find((c) => c.id === input.centerId);
    if (!center) throw new CrmError("Pick one of the centers in the list.", "input");
    return connected(pending.apiKey, center);
  }
  const apiKey = input.action === "resume" && pending?.apiKey ? pending.apiKey : cleanKey(input.apiKey);
  const centers = await listCenters(apiKey);
  if (!centers.length) throw new CrmError("This Zenoti key can't see any centers.", "input");
  if (centers.length === 1) return connected(apiKey, centers[0]);
  return {
    status: "pending",
    credentials: { apiKey },
    accountLabel: null,
    externalId: null,
    step: {
      kind: "choose",
      field: "centerId",
      label: "Which center are these leads for?",
      options: centers.map((c) => ({ value: c.id, label: c.name })),
    },
  };
}

function guestRecord(g: unknown): LeadRecord {
  const o = obj(g);
  const p = obj(o.personal_info);
  const phone = (v: unknown) => str(obj(v).number) ?? str(obj(v).display_number);
  return {
    externalId: str(o.id) ?? str(o.code),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    email: str(p.email),
    phones: [phone(p.mobile_phone), phone(p.home_phone), phone(p.work_phone)],
    source: str(obj(obj(o.referral).referral_source).name),
  };
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchLeads(creds: Credentials, opts: FetchOptions): Promise<FetchResult> {
  const { apiKey, centerId } = creds;
  if (!apiKey || !centerId) throw new CrmError("Connect Zenoti again.", "auth");
  const cur = decodeCursor(opts.cursor);
  const startPage = typeof cur?.p === "number" && cur.p >= 1 && cur.p <= 100_000 ? Math.floor(cur.p) : 1;
  const since =
    typeof cur?.s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cur.s) ? cur.s : cur ? null : opts.since ? day(opts.since) : null;
  const pages = Math.max(1, Math.ceil(opts.limit / ZENOTI_PAGE_SIZE));

  const records: LeadRecord[] = [];
  let page = startPage;
  let more = true;
  for (let i = 0; i < pages && more; i++) {
    if (i > 0) await http.sleep(ZENOTI_CALL_GAP_MS);
    const query: Record<string, string> = { center_id: centerId, page: String(page), size: String(ZENOTI_PAGE_SIZE) };
    if (since) query.last_updated = since;
    const body = await get(apiKey, "/guests", query);
    const guests = arr(body.guests);
    for (const g of guests) records.push(guestRecord(g));
    more = guests.length >= ZENOTI_PAGE_SIZE;
    page++;
  }
  return {
    records,
    startIndex: (startPage - 1) * ZENOTI_PAGE_SIZE,
    nextCursor: more ? encodeCursor({ p: page, s: since }) : null,
  };
}

export const zenoti: CrmAdapter = {
  provider: "zenoti",
  label: "Zenoti",
  unavailableReason: () => null,
  connectFields: [
    {
      name: "apiKey",
      label: "API key",
      type: "password",
      placeholder: "Paste your Zenoti API key",
      help: "In Zenoti: Configuration, then Integrations, then Apps. Add a backend app with read access to guests and centers, then Generate API Key.",
    },
  ],
  connect,
  fetchLeads,
};
