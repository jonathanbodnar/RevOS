/**
 * Aesthetic Record "connector": honest about what exists.
 *
 * Aesthetic Record has no public API. What it documents is for pushing leads
 * IN (its Leads API, keys issued to approved partners or by its support), not
 * for reading a clinic's clients or leads out. So connecting only records that
 * the clinic asked (status "pending"), and the card tells them to ask
 * Aesthetic Record support for an API key for RevOS, and to export their
 * client list to Excel and upload it meanwhile. No endpoints are called.
 */
import { CrmError, type ConnectOutcome, type CrmAdapter } from "./types";

/** Export steps as Aesthetic Record's help center gives them. */
export const AESTHETIC_RECORD_EXPORT_STEPS = [
  "In Aesthetic Record, open Clients (or Patients).",
  "Click + and pick the columns to include (name, phone, email).",
  "Click Import/Export, then Export as Excel.",
  "Upload that file below.",
];

async function connect(): Promise<ConnectOutcome> {
  return { status: "pending", credentials: null, accountLabel: null, externalId: null, step: { kind: "requested" } };
}

export const aestheticRecord: CrmAdapter = {
  provider: "aesthetic_record",
  label: "Aesthetic Record",
  unavailableReason: () => null,
  connectFields: [],
  connect,
  async fetchLeads() {
    throw new CrmError(
      "Aesthetic Record doesn't let other apps read your client list yet. Export it to Excel and upload it instead.",
      "unavailable",
    );
  },
};
