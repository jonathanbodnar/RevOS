/** CRM connector registry. */
import { aestheticRecord } from "./aesthetic-record";
import { mindbody } from "./mindbody";
import type { CrmAdapter, CrmProvider } from "./types";
import { zenoti } from "./zenoti";

export const ADAPTERS: Record<CrmProvider, CrmAdapter> = {
  zenoti,
  mindbody,
  aesthetic_record: aestheticRecord,
};

export function adapterFor(provider: CrmProvider): CrmAdapter {
  return ADAPTERS[provider];
}

export { CRM_PROVIDERS, isCrmProvider, CrmError, crmErrorStatus } from "./types";
export type { CrmProvider, ConnectStep, ConnectField } from "./types";
