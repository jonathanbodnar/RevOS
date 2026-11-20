/**
 * Clinic CRM connectors: the shape every adapter implements.
 *
 * An adapter knows how to connect a clinic's account (in one or more steps)
 * and how to page through its leads. It never touches the database: the
 * server code in integrations.ts stores credentials (encrypted), runs the
 * steps and feeds fetched leads through the same import path as a file.
 */
import type { LeadRecord } from "../call-center/import";

export const CRM_PROVIDERS = ["zenoti", "mindbody", "aesthetic_record"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export function isCrmProvider(v: unknown): v is CrmProvider {
  return typeof v === "string" && (CRM_PROVIDERS as readonly string[]).includes(v);
}

/** A field the clinic fills in on the Connect card. */
export type ConnectField = {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  help?: string;
};

/** Secrets and ids for one clinic's account. Stored encrypted, never sent to a browser. */
export type Credentials = Record<string, string>;

/** What the card shows next when connecting takes more than one step. */
export type ConnectStep =
  /** Pick one of several (Zenoti: which center). */
  | { kind: "choose"; field: string; label: string; options: { value: string; label: string }[] }
  /** The account owner approves RevOS elsewhere, then comes back (Mindbody). */
  | { kind: "approve"; url: string | null; code: string | null }
  /** Nothing to connect yet; the request was noted (Aesthetic Record). */
  | { kind: "requested" };

export type ConnectOutcome =
  | { status: "connected"; credentials: Credentials; accountLabel: string; externalId: string | null }
  | {
      status: "pending";
      credentials: Credentials | null;
      accountLabel: string | null;
      externalId: string | null;
      step: ConnectStep;
    };

export type FetchOptions = {
  /** Only leads changed since then (first page of a sync). */
  since?: Date | null;
  /** Most leads to return from this call. */
  limit: number;
  /** Where the previous call stopped (from nextCursor). */
  cursor?: string | null;
};

export type FetchResult = {
  records: LeadRecord[];
  /** Position of records[0] in the whole sync, so leads keep the CRM's order. */
  startIndex: number;
  /** Pass back to continue; null when there's nothing more. */
  nextCursor: string | null;
};

export interface CrmAdapter {
  provider: CrmProvider;
  label: string;
  /** Null when the connector can be used; otherwise the reason, for the card. */
  unavailableReason(): string | null;
  /** First-step fields. */
  connectFields: ConnectField[];
  /**
   * Run a connect step. `pending` holds what an earlier step stored (for
   * example the API key while the clinic picks a center). `input.action` is
   * "resume" to show a pending step again, or "check" to finish one.
   */
  connect(input: Record<string, string>, pending: Credentials | null): Promise<ConnectOutcome>;
  fetchLeads(credentials: Credentials, opts: FetchOptions): Promise<FetchResult>;
}

export type CrmErrorKind = "input" | "auth" | "pending" | "rate" | "unavailable" | "upstream";

/** A short message safe to show and to store in ClinicIntegration.lastError (never a secret). */
export class CrmError extends Error {
  constructor(
    message: string,
    readonly kind: CrmErrorKind,
  ) {
    super(message);
    this.name = "CrmError";
  }
}

/** HTTP status for a CrmError in our own API responses. */
export function crmErrorStatus(e: CrmError): number {
  switch (e.kind) {
    case "input":
    case "auth":
    case "pending":
      return 400;
    case "rate":
      return 429;
    case "unavailable":
      return 409;
    default:
      return 502;
  }
}

/** Opaque paging cursor: base64url JSON with small numeric/date fields. */
export function encodeCursor(value: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor || cursor.length > 500) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
