/** Aesthetic Record has no read API: connecting records a request and calls nothing. */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { http } from "./http";
import { aestheticRecord, AESTHETIC_RECORD_EXPORT_STEPS } from "./aesthetic-record";

let fetches: number;
beforeEach(() => {
  fetches = 0;
  mock.method(http, "fetch", async () => {
    fetches++;
    throw new Error("Aesthetic Record must not be called");
  });
});
afterEach(() => mock.restoreAll());

test("asking for access is recorded as pending with nothing stored and no request made", async () => {
  assert.equal(aestheticRecord.unavailableReason(), null);
  assert.deepEqual(aestheticRecord.connectFields, []);
  assert.deepEqual(await aestheticRecord.connect({}, null), {
    status: "pending",
    credentials: null,
    accountLabel: null,
    externalId: null,
    step: { kind: "requested" },
  });
  assert.equal(fetches, 0);
});

test("pulling leads explains the spreadsheet route instead", async () => {
  await assert.rejects(aestheticRecord.fetchLeads({}, { limit: 10 }), { name: "CrmError", kind: "unavailable", message: /Export it to Excel/ });
  assert.ok(AESTHETIC_RECORD_EXPORT_STEPS.some((s) => /Export as Excel/.test(s)));
  assert.equal(fetches, 0);
});
