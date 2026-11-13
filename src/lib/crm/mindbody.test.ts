/**
 * Mindbody connector request shapes and mapping (Public API v6 docs). fetch
 * is mocked; the developer credentials below are fake.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { http } from "./http";
import { decodeCursor } from "./types";
import { mindbody } from "./mindbody";

type Call = { url: URL; init: RequestInit };
let calls: Call[];
let replies: Response[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setEnv(on: boolean) {
  if (on) {
    process.env.MINDBODY_API_KEY = "mb-test-key";
    process.env.MINDBODY_SOURCE_NAME = "RevOSTest";
    process.env.MINDBODY_SOURCE_PASSWORD = "not-a-real-password";
  } else {
    delete process.env.MINDBODY_API_KEY;
    delete process.env.MINDBODY_SOURCE_NAME;
    delete process.env.MINDBODY_SOURCE_PASSWORD;
  }
}

beforeEach(() => {
  calls = [];
  replies = [];
  setEnv(true);
  mock.method(http, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next;
  });
  mock.method(http, "sleep", async () => {});
});
afterEach(() => {
  mock.restoreAll();
  setEnv(false);
});

const headers = (c: Call) => c.init.headers as Record<string, string>;

test("without RevOS's developer key the card says Mindbody isn't available, and nothing is called", async () => {
  setEnv(false);
  assert.match(mindbody.unavailableReason() ?? "", /isn't available yet/);
  await assert.rejects(mindbody.connect({ siteId: "123" }, null), { name: "CrmError", kind: "unavailable" });
  await assert.rejects(mindbody.fetchLeads({ siteId: "123" }, { limit: 10 }), { kind: "unavailable" });
  assert.equal(calls.length, 0);
  setEnv(true);
  assert.equal(mindbody.unavailableReason(), null);
});

test("step one: the Site ID gets an activation link and code for the owner", async () => {
  replies.push(json({ ActivationCode: "AB12CD", ActivationLink: "https://clients.mindbodyonline.com/ActivateLink?x=1" }));
  const out = await mindbody.connect({ siteId: " 123456 " }, null);
  assert.deepEqual(out, {
    status: "pending",
    credentials: { siteId: "123456" },
    accountLabel: "Site 123456",
    externalId: "123456",
    step: { kind: "approve", url: "https://clients.mindbodyonline.com/ActivateLink?x=1", code: "AB12CD" },
  });
  const c = calls[0];
  assert.equal(c.url.href, "https://api.mindbodyonline.com/public/v6/site/activationcode");
  assert.equal(c.init.method, "GET");
  assert.equal(headers(c)["Api-Key"], "mb-test-key");
  assert.equal(headers(c).SiteId, "123456");
  assert.equal(headers(c).Authorization, undefined);

  await assert.rejects(mindbody.connect({ siteId: "my site" }, null), { kind: "input" });
  assert.equal(calls.length, 1);
});

test("check: a staff token from the integration login, one client read, then the site name", async () => {
  replies.push(json({ TokenType: "Bearer", AccessToken: "tok-1", Expires: "2026-11-20T00:00:00Z" }));
  replies.push(json({ PaginationResponse: { TotalResults: 1 }, Clients: [{ Id: "1" }] }));
  replies.push(json({ Sites: [{ Id: -99, Name: "Sandbox Med Spa" }] }));
  const out = await mindbody.connect({ action: "check" }, { siteId: "-99" });
  assert.deepEqual(out, { status: "connected", credentials: { siteId: "-99" }, accountLabel: "Sandbox Med Spa", externalId: "-99" });

  const [issue, clients, sites] = calls;
  assert.equal(issue.url.pathname, "/public/v6/usertoken/issue");
  assert.equal(issue.init.method, "POST");
  assert.deepEqual(JSON.parse(String(issue.init.body)), { Username: "_RevOSTest", Password: "not-a-real-password" });
  assert.equal(headers(issue).SiteId, "-99");
  assert.equal(clients.url.pathname, "/public/v6/client/clients");
  assert.equal(clients.url.searchParams.get("request.limit"), "1");
  assert.equal(headers(clients).Authorization, "Bearer tok-1");
  assert.equal(sites.url.searchParams.get("request.siteIds[0]"), "-99");
  // The credentials kept are only the site id: no token, no password.
  assert.deepEqual(Object.keys(out.credentials ?? {}), ["siteId"]);
});

test("check before the owner approves: a clear 'not approved yet', not a crash", async () => {
  replies.push(json({ Error: { Message: "Staff member not found", Code: "StaffMemberNotFound" } }, 403));
  await assert.rejects(mindbody.connect({ action: "check" }, { siteId: "123" }), (e: { kind?: string; message?: string }) => {
    assert.equal(e.kind, "pending");
    assert.match(e.message ?? "", /approve/);
    return true;
  });
  replies.push(json({ Error: { Message: "x", Code: "InvalidSiteId" } }, 400));
  await assert.rejects(mindbody.connect({ siteId: "999" }, null), { kind: "input", message: "Mindbody doesn't recognize that Site ID." });
});

test("clients: 200 a page with offset, lastModifiedDate on later syncs, mobile phone first", async () => {
  replies.push(json({ AccessToken: "tok-2" }));
  replies.push(
    json({
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: 200, TotalResults: 250 },
      Clients: Array.from({ length: 200 }, (_, i) => ({
        Id: `c${i}`,
        UniqueId: 1000 + i,
        FirstName: "Test",
        LastName: `Client${i}`,
        Email: `c${i}@example.test`,
        MobilePhone: i === 0 ? null : "5550100201",
        HomePhone: "5550100202",
        IsProspect: i === 0,
        ProspectStage: i === 0 ? { Id: 1, Description: "Contacted", Active: true } : null,
        Status: "Non-Member",
      })),
    }),
  );
  replies.push(json({ PaginationResponse: { TotalResults: 250 }, Clients: Array.from({ length: 50 }, (_, i) => ({ UniqueId: 2000 + i, MobilePhone: "5550100203" })) }));
  const res = await mindbody.fetchLeads({ siteId: "123" }, { since: new Date("2026-11-01T12:00:00Z"), limit: 500 });
  assert.equal(res.records.length, 250);
  assert.equal(res.nextCursor, null);
  const pages = calls.slice(1).map((c) => Object.fromEntries(c.url.searchParams));
  assert.deepEqual(pages, [
    { "request.limit": "200", "request.offset": "0", "request.lastModifiedDate": "2026-11-01" },
    { "request.limit": "200", "request.offset": "200", "request.lastModifiedDate": "2026-11-01" },
  ]);
  assert.ok(calls.slice(1).every((c) => headers(c).Authorization === "Bearer tok-2"));
  assert.deepEqual(res.records[0], {
    externalId: "1000",
    firstName: "Test",
    lastName: "Client0",
    email: "c0@example.test",
    phones: [null, "5550100202", null],
    status: "Contacted",
  });
  assert.equal(res.records[1].status, "Non-Member");
});

test("a batch limit stops early and the cursor resumes at the next offset", async () => {
  replies.push(json({ AccessToken: "tok-3" }));
  replies.push(json({ PaginationResponse: { TotalResults: 1000 }, Clients: Array.from({ length: 200 }, () => ({ MobilePhone: "5550100204" })) }));
  const res = await mindbody.fetchLeads({ siteId: "123" }, { limit: 200 });
  assert.deepEqual(decodeCursor(res.nextCursor), { o: 200, s: null });
  assert.equal(calls[1].url.searchParams.get("request.lastModifiedDate"), null, "first sync pulls everyone");
});
