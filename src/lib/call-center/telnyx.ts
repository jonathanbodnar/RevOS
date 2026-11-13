/**
 * Thin Telnyx REST client (API v2) + webhook signature check.
 *
 * Only the calls the call center uses: Call Control (dial, answer, bridge,
 * hangup, speak), the browser-phone credentials (telephony credentials + JWT),
 * account setup (outbound voice profile, Call Control application, credential
 * connection) and numbers (search, order, assign). Field names follow Telnyx's
 * published OpenAPI spec (team-telnyx/openapi spec3.json).
 *
 * Env:
 *   TELNYX_API_KEY     — v2 API key (Mission Control → API Keys). Required.
 *   TELNYX_PUBLIC_KEY  — account public key for webhook signatures
 *                        (Mission Control → Keys & Credentials → Public Key).
 *   TELNYX_API_BASE    — override for tests only.
 */
import crypto from "crypto";

export class TelnyxError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "TelnyxError";
  }
}

export function telnyxConfigured(): boolean {
  return !!process.env.TELNYX_API_KEY;
}

function base(): string {
  return (process.env.TELNYX_API_BASE || "https://api.telnyx.com/v2").replace(/\/$/, "");
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  opts: { text?: boolean } = {},
): Promise<T> {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new TelnyxError("Telnyx isn't connected yet. Set TELNYX_API_KEY.", 503, "not_configured");
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: opts.text ? "text/plain" : "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (e) {
    throw new TelnyxError(`Couldn't reach Telnyx: ${e instanceof Error ? e.message : String(e)}`, 502, "network");
  }
  if (!res.ok) {
    let message = `Telnyx returned ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { errors?: { code?: string; title?: string; detail?: string }[] };
      const e = j.errors?.[0];
      if (e) {
        message = [e.title, e.detail].filter(Boolean).join(": ") || message;
        code = e.code;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new TelnyxError(message, res.status, code);
  }
  if (opts.text) return (await res.text()) as T;
  if (res.status === 204) return undefined as T;
  const j = (await res.json()) as { data?: T };
  return j.data as T;
}

export type DialResult = { call_control_id: string; call_leg_id: string; call_session_id: string };
export type AvailableNumber = {
  phone_number: string;
  region_information?: { region_type?: string; region_name?: string }[];
  cost_information?: { monthly_cost?: string; upfront_cost?: string; currency?: string };
  features?: { name: string }[];
};

/** Base64 JSON carried on every webhook for a call. */
export function encodeClientState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}
export function decodeClientState(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toE164(phone10: string): string {
  const d = phone10.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return phone10.startsWith("+") ? phone10 : `+${d}`;
}

export const telnyx = {
  dial(input: {
    connectionId: string;
    to: string;
    from: string;
    fromDisplayName?: string;
    timeoutSecs: number;
    clientState: string;
    answeringMachineDetection?: "premium" | "detect" | "disabled";
    linkTo?: string;
    commandId?: string;
  }): Promise<DialResult> {
    return request<DialResult>("POST", "/calls", {
      connection_id: input.connectionId,
      to: input.to,
      from: input.from,
      ...(input.fromDisplayName ? { from_display_name: input.fromDisplayName.slice(0, 128) } : {}),
      timeout_secs: input.timeoutSecs,
      // Don't keep trying other routes after our ring time; that would ring past it.
      retry_on_timeout: false,
      client_state: input.clientState,
      answering_machine_detection: input.answeringMachineDetection ?? "disabled",
      ...(input.linkTo ? { link_to: input.linkTo } : {}),
      ...(input.commandId ? { command_id: input.commandId } : {}),
    });
  },
  answer(callControlId: string, opts: { clientState?: string; commandId?: string } = {}) {
    return request<unknown>("POST", `/calls/${encodeURIComponent(callControlId)}/actions/answer`, {
      ...(opts.clientState ? { client_state: opts.clientState } : {}),
      ...(opts.commandId ? { command_id: opts.commandId } : {}),
      send_silence_when_idle: true,
    });
  },
  /** Bridge `otherCallControlId` onto `callControlId`; the first leg parks after the other hangs up. */
  bridge(
    callControlId: string,
    otherCallControlId: string,
    opts: { playRingtone?: boolean; parkAfterUnbridge?: boolean; clientState?: string; commandId?: string } = {},
  ) {
    return request<unknown>("POST", `/calls/${encodeURIComponent(callControlId)}/actions/bridge`, {
      call_control_id: otherCallControlId,
      ...(opts.parkAfterUnbridge ? { park_after_unbridge: "self" } : {}),
      ...(opts.playRingtone ? { play_ringtone: true, ringtone: "us" } : {}),
      ...(opts.clientState ? { client_state: opts.clientState } : {}),
      ...(opts.commandId ? { command_id: opts.commandId } : {}),
    });
  },
  hangup(callControlId: string, opts: { commandId?: string } = {}) {
    return request<unknown>("POST", `/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
      ...(opts.commandId ? { command_id: opts.commandId } : {}),
    });
  },
  speak(callControlId: string, text: string, opts: { clientState?: string } = {}) {
    return request<unknown>("POST", `/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      payload: text.slice(0, 2900),
      payload_type: "text",
      voice: "AWS.Polly.Joanna-Neural",
      language: "en-US",
      ...(opts.clientState ? { client_state: opts.clientState } : {}),
    });
  },

  // ── Account setup ─────────────────────────────────────────────────────────
  createOutboundVoiceProfile(name: string) {
    return request<{ id: string }>("POST", "/outbound_voice_profiles", {
      name,
      traffic_type: "conversational",
      service_plan: "global",
      whitelisted_destinations: ["US"],
    });
  },
  createCallControlApp(input: { name: string; webhookUrl: string; outboundVoiceProfileId: string }) {
    return request<{ id: string }>("POST", "/call_control_applications", {
      application_name: input.name,
      webhook_event_url: input.webhookUrl,
      webhook_api_version: "2",
      first_command_timeout: true,
      first_command_timeout_secs: 30,
      outbound: { outbound_voice_profile_id: input.outboundVoiceProfileId },
    });
  },
  updateCallControlApp(id: string, input: { webhookUrl: string }) {
    return request<{ id: string }>("PATCH", `/call_control_applications/${encodeURIComponent(id)}`, {
      webhook_event_url: input.webhookUrl,
      webhook_api_version: "2",
    });
  },
  createCredentialConnection(input: {
    name: string;
    userName: string;
    password: string;
    webhookUrl: string;
    outboundVoiceProfileId: string;
  }) {
    return request<{ id: string }>("POST", "/credential_connections", {
      connection_name: input.name,
      user_name: input.userName,
      password: input.password,
      webhook_event_url: input.webhookUrl,
      webhook_api_version: "2",
      // Every call the browser phone places is parked and handed to our
      // webhook instead of going straight out; RevOS decides what to do.
      outbound: { call_parking_enabled: true, outbound_voice_profile_id: input.outboundVoiceProfileId },
    });
  },
  updateCredentialConnection(id: string, input: { webhookUrl: string }) {
    return request<{ id: string }>("PATCH", `/credential_connections/${encodeURIComponent(id)}`, {
      webhook_event_url: input.webhookUrl,
      webhook_api_version: "2",
    });
  },
  createTelephonyCredential(input: { connectionId: string; name: string; tag: string }) {
    return request<{ id: string; sip_username: string }>("POST", "/telephony_credentials", {
      connection_id: input.connectionId,
      name: input.name,
      tag: input.tag,
    });
  },
  /** A 24-hour JWT for the browser phone (POST /telephony_credentials/{id}/token, text/plain). */
  credentialToken(credentialId: string) {
    return request<string>("POST", `/telephony_credentials/${encodeURIComponent(credentialId)}/token`, undefined, {
      text: true,
    });
  },

  // ── Numbers ───────────────────────────────────────────────────────────────
  searchNumbers(input: { areaCode?: string; state?: string; city?: string; limit?: number }) {
    const q = new URLSearchParams();
    q.set("filter[country_code]", "US");
    q.set("filter[phone_number_type]", "local");
    q.append("filter[features][]", "voice");
    q.append("filter[features][]", "sms");
    if (input.areaCode) q.set("filter[national_destination_code]", input.areaCode);
    if (input.state) q.set("filter[administrative_area]", input.state);
    if (input.city) q.set("filter[locality]", input.city);
    q.set("filter[limit]", String(Math.min(Math.max(input.limit ?? 10, 1), 30)));
    return request<AvailableNumber[]>("GET", `/available_phone_numbers?${q.toString()}`);
  },
  orderNumber(input: { phoneNumber: string; connectionId: string; customerReference?: string }) {
    return request<{ id: string; status: string; phone_numbers?: { id?: string; phone_number: string; status?: string }[] }>(
      "POST",
      "/number_orders",
      {
        phone_numbers: [{ phone_number: input.phoneNumber }],
        connection_id: input.connectionId,
        ...(input.customerReference ? { customer_reference: input.customerReference } : {}),
      },
    );
  },
  findNumber(e164: string) {
    return request<{ id: string; phone_number: string; connection_id?: string | null; status?: string }[]>(
      "GET",
      `/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`,
    ).then((rows) => rows?.[0] ?? null);
  },
  assignNumber(numberId: string, connectionId: string) {
    return request<{ id: string }>("PATCH", `/phone_numbers/${encodeURIComponent(numberId)}`, {
      connection_id: connectionId,
    });
  },
};

export type TelnyxClient = typeof telnyx;

// Ed25519 SubjectPublicKeyInfo prefix, so a raw 32-byte key can be imported.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify a Telnyx v2 webhook: Ed25519 over `${timestamp}|${rawBody}` with the
 * account public key, and the timestamp within `toleranceSec` of now.
 */
export function verifyTelnyxSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey?: string | null;
  nowSec?: number;
  toleranceSec?: number;
}): boolean {
  const publicKey = input.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey || !input.signature || !input.timestamp) return false;
  const ts = Number(input.timestamp);
  const now = input.nowSec ?? Date.now() / 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (input.toleranceSec ?? 300)) return false;
  try {
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    const sig = Buffer.from(input.signature, "base64");
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(`${input.timestamp}|${input.rawBody}`, "utf8"), key, sig);
  } catch {
    return false;
  }
}
