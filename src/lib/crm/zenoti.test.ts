/**
 * Zenoti connector request shapes and mapping (docs.zenoti.com). fetch is
 * mocked; no request leaves the process.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { http } from "./http";
import { CrmError, decodeCursor } from "./types";
import { listCenters, zenoti, ZENOTI_CALL_GAP_MS } from "./zenoti";

const KEY = "zk_test_0000000000";

type Call = { url: URL; init: RequestInit };
let calls: Call[];
let replies: (Response | Error)[];
let sleeps: number[];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  replies = [];
  sleeps = [];
  mock.method(http, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  mock.method(http, "sleep", async (ms: number) => {
    sleeps.push(ms);
  });
});
afterEach(() => mock.restoreAll());

const guest = (i: number) => ({
  id: `guest-${i}`,
  code: `G${i}`,
  center_id: "center-1",
  personal_info: {
    first_name: "Test",
    last_name: `Guest${i}`,
    email: `guest${i}@example.test`,
    mobile_phone: { country_code: 225, number: `55501${String(i % 100).padStart(5, "0")}` },
  },
  referral: { referral_source: { id: "r1", name: "Instagram" } },
});

test("the key is checked by listing centers with the apikey header; one center connects at once", async () => {
  replies.push(json({ centers: [{ id: "center-1", code: "DT", name: "Downtown", display_name: "Downtown Med Spa" }], page_info: { total: 1 } }));
  const out = await zenoti.connect({ apiKey: `  ${KEY} ` }, null);
  assert.deepEqual(out, {
    status: "connected",
    credentials: { apiKey: KEY, centerId: "center-1" },
    accountLabel: "Downtown Med Spa",
    externalId: "center-1",
  });
  const { url, init } = calls[0];
  assert.equal(url.origin + url.pathname, "https://api.zenoti.com/v1/centers");
  assert.equal(url.searchParams.get("size"), "100");
  assert.deepEqual(init.headers, { Authorization: `apikey ${KEY}`, Accept: "application/json" });
  assert.equal(init.method, "GET");
});

test("several centers: pick one, then connect with the key kept from step one", async () => {
  const centers = { centers: [{ id: "c1", name: "Downtown" }, { id: "c2", name: "Uptown", display_name: "Uptown Spa" }] };
  replies.push(json(centers));
  const step1 = await zenoti.connect({ apiKey: KEY }, null);
  assert.equal(step1.status, "pending");
  assert.deepEqual(step1.status === "pending" && step1.step, {
    kind: "choose",
    field: "centerId",
    label: "Which center are these leads for?",
    options: [
      { value: "c1", label: "Downtown" },
      { value: "c2", label: "Uptown Spa" },
    ],
  });
  assert.deepEqual(step1.credentials, { apiKey: KEY });

  replies.push(json(centers));
  const step2 = await zenoti.connect({ centerId: "c2" }, { apiKey: KEY });
  assert.deepEqual(step2, { status: "connected", credentials: { apiKey: KEY, centerId: "c2" }, accountLabel: "Uptown Spa", externalId: "c2" });

  replies.push(json(centers));
  await assert.rejects(zenoti.connect({ centerId: "c9" }, { apiKey: KEY }), { name: "CrmError", kind: "input" });
  await assert.rejects(zenoti.connect({ centerId: "c1" }, null), { kind: "input" });
});

test("a rejected key gives a short message without the key; blank keys never call Zenoti", async () => {
  replies.push(json({}, 401));
  await assert.rejects(zenoti.connect({ apiKey: KEY }, null), (e: unknown) => {
    assert.ok(e instanceof CrmError);
    assert.equal(e.kind, "auth");
    assert.doesNotMatch(e.message, new RegExp(KEY));
    return true;
  });
  await assert.rejects(zenoti.connect({ apiKey: "  " }, null), { kind: "input" });
  await assert.rejects(zenoti.connect({ apiKey: "has space" }, null), { kind: "input" });
  assert.equal(calls.length, 1);
});

test("429 waits for Retry-After and tries once more; errors in the body are failures", async () => {
  replies.push(json({}, 429, { "retry-after": "3" }), json({ centers: [{ id: "c1", name: "A" }] }));
  assert.deepEqual(await listCenters(KEY), [{ id: "c1", name: "A" }]);
  assert.deepEqual(sleeps, [3000]);

  replies.push(json({}, 429), json({}, 429));
  await assert.rejects(listCenters(KEY), { kind: "rate" });

  replies.push(json({ centers: [], error: { code: 500, message: "boom" } }));
  await assert.rejects(listCenters(KEY), { kind: "upstream" });

  replies.push(new Error("ECONNRESET"));
  await assert.rejects(listCenters(KEY), { message: "Couldn't reach Zenoti. Try again in a minute." });
});

test("guests: center, page size 100, last_updated on later syncs, paged until a short page", async () => {
  replies.push(json({ guests: Array.from({ length: 100 }, (_, i) => guest(i)) }));
  replies.push(json({ guests: [guest(100), guest(101)] }));
  const res = await zenoti.fetchLeads(
    { apiKey: KEY, centerId: "center-1" },
    { since: new Date("2026-11-01T05:00:00Z"), limit: 500 },
  );
  assert.equal(res.records.length, 102);
  assert.equal(res.nextCursor, null);
  assert.equal(res.startIndex, 0);
  assert.deepEqual(
    calls.map((c) => Object.fromEntries(c.url.searchParams)),
    [
      { center_id: "center-1", page: "1", size: "100", last_updated: "2026-11-01" },
      { center_id: "center-1", page: "2", size: "100", last_updated: "2026-11-01" },
    ],
  );
  assert.equal(calls[0].url.pathname, "/v1/guests");
  assert.deepEqual(sleeps, [ZENOTI_CALL_GAP_MS], "calls are spaced for the 60-a-minute limit");
  assert.deepEqual(res.records[0], {
    externalId: "guest-0",
    firstName: "Test",
    lastName: "Guest0",
    email: "guest0@example.test",
    phones: ["5550100000", null, null],
    source: "Instagram",
  });
});

test("a full batch hands back a cursor that resumes on the next page", async () => {
  const page = () => json({ guests: Array.from({ length: 100 }, (_, i) => guest(i)) });
  replies.push(page(), page());
  const first = await zenoti.fetchLeads({ apiKey: KEY, centerId: "center-1" }, { limit: 200 });
  assert.equal(first.records.length, 200);
  assert.deepEqual(decodeCursor(first.nextCursor), { p: 3, s: null });

  replies.push(json({ guests: [] }));
  const next = await zenoti.fetchLeads({ apiKey: KEY, centerId: "center-1" }, { limit: 200, cursor: first.nextCursor, since: new Date() });
  assert.equal(next.startIndex, 200);
  assert.equal(calls.at(-1)?.url.searchParams.get("page"), "3");
  assert.equal(calls.at(-1)?.url.searchParams.get("last_updated"), null, "the cursor's since wins");
  assert.equal(next.nextCursor, null);
});

test("missing credentials ask for a reconnect instead of calling Zenoti", async () => {
  await assert.rejects(zenoti.fetchLeads({ apiKey: KEY }, { limit: 10 }), { kind: "auth" });
  assert.equal(calls.length, 0);
});
