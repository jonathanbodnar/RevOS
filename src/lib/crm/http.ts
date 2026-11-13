/**
 * The one way CRM adapters make HTTP calls. `http.fetch` and `http.sleep` are
 * properties so tests can replace them with mock.method; no test ever calls a
 * real vendor.
 */
import { CrmError } from "./types";

export const http = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type JsonResponse = { status: number; body: unknown; headers: Headers };

/**
 * Call a vendor and parse JSON. Network failures and timeouts become a short
 * CrmError naming the vendor; HTTP errors are returned for the adapter to map.
 */
export async function requestJson(
  vendor: string,
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<JsonResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await http.fetch(url, { ...init, signal: ctrl.signal, cache: "no-store", redirect: "error" });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, headers: res.headers };
  } catch {
    throw new CrmError(`Couldn't reach ${vendor}. Try again in a minute.`, "upstream");
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds to wait after a 429, from Retry-After, capped. */
export function retryAfterMs(headers: Headers, fallbackSeconds = 5, maxSeconds = 20): number {
  const raw = Number(headers.get("retry-after"));
  const s = Number.isFinite(raw) && raw > 0 ? raw : fallbackSeconds;
  return Math.min(s, maxSeconds) * 1000;
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
