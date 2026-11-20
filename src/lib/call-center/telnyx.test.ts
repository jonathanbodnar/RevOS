import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decodeClientState, encodeClientState, toE164, verifyTelnyxSignature } from "./telnyx";
import { checkCallingHours, DEFAULT_RULES } from "./rules";
import { zonedTimeToUtc } from "./time";

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: Buffer.from(raw).toString("base64"), privateKey };
}

test("webhook signatures: valid, tampered, stale, wrong key, missing", () => {
  const { publicKey, privateKey } = keypair();
  const body = JSON.stringify({ data: { event_type: "call.answered", payload: { call_control_id: "v3:abc" } } });
  const ts = "1763049600";
  const signature = crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
  const nowSec = Number(ts) + 10;
  assert.equal(verifyTelnyxSignature({ rawBody: body, signature, timestamp: ts, publicKey, nowSec }), true);
  assert.equal(verifyTelnyxSignature({ rawBody: body + " ", signature, timestamp: ts, publicKey, nowSec }), false);
  assert.equal(verifyTelnyxSignature({ rawBody: body, signature, timestamp: ts, publicKey, nowSec: nowSec + 600 }), false);
  assert.equal(verifyTelnyxSignature({ rawBody: body, signature, timestamp: ts, publicKey: keypair().publicKey, nowSec }), false);
  assert.equal(verifyTelnyxSignature({ rawBody: body, signature: null, timestamp: ts, publicKey, nowSec }), false);
  assert.equal(verifyTelnyxSignature({ rawBody: body, signature, timestamp: ts, publicKey: null, nowSec }), false);
  assert.equal(verifyTelnyxSignature({ rawBody: body, signature: "not base64!!", timestamp: ts, publicKey, nowSec }), false);
});

test("client state round-trips and rejects junk", () => {
  const s = encodeClientState({ t: "lead", c: "call1", s: "sess1" });
  assert.deepEqual(decodeClientState(s), { t: "lead", c: "call1", s: "sess1" });
  assert.equal(decodeClientState("%%%"), null);
  assert.equal(decodeClientState(undefined), null);
});

test("E.164 for US numbers", () => {
  assert.equal(toE164("5550100123"), "+15550100123");
  assert.equal(toE164("15550100123"), "+15550100123");
  assert.equal(toE164("+15550100123"), "+15550100123");
});

test("calling hours: clinic time, never Sunday, work days only", () => {
  const r = { ...DEFAULT_RULES, timezone: "America/New_York" };
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-11T09:00", "America/New_York")!, r).ok, true);
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-11T08:59", "America/New_York")!, r).ok, false);
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-11T19:00", "America/New_York")!, r).ok, false);
  // 9:30 Central is 10:30 Eastern: the clinic's zone decides.
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-11T18:30", "America/Chicago")!, r).ok, false);
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-15T12:00", "America/New_York")!, { ...r, workDays: [1, 2, 3, 4, 5, 6] }).ok, false);
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-14T12:00", "America/New_York")!, r).ok, false);
  // Rules can't push past 8 AM – 9 PM even if a row says so.
  assert.equal(checkCallingHours(zonedTimeToUtc("2026-11-11T07:30", "America/New_York")!, { ...r, callStartMinute: 0 }).ok, false);
});
