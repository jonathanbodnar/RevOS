/**
 * LunarPay API client.
 *
 * Single merchant model: every clinic in RevOS charges through ONE LunarPay
 * merchant account (one lp_sk_ / lp_pk_). LunarPay has no native concept of
 * "clinic" — we tag each charge's description with a clinic prefix so it
 * shows up legibly inside the LunarPay dashboard, and we keep the
 * clinic <-> lunarpay_customer_id mapping in our own DB.
 *
 * Never import this file from a client component — it uses the secret key.
 */

const BASE_URL = process.env.LUNARPAY_BASE_URL || "https://app.lunarpay.com";
const SECRET_KEY = process.env.LUNARPAY_SECRET_KEY || "";
export const PUBLISHABLE_KEY = process.env.LUNARPAY_PUBLISHABLE_KEY || "";

export class LunarPayError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!SECRET_KEY) {
    throw new LunarPayError(
      "LUNARPAY_SECRET_KEY is not configured on the server.",
      503,
    );
  }
  const reqBody = body ? JSON.stringify(body) : undefined;
  const startedAt = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: reqBody,
    cache: "no-store",
  });
  const text = await res.text();
  const json = text ? safeJson(text) : {};
  const elapsedMs = Date.now() - startedAt;

  if (!res.ok) {
    const j = json as { error?: string; message?: string; errors?: unknown };
    const msg = j?.error || j?.message || `LunarPay ${res.status}`;
    // CRITICAL: log every failed LunarPay call with the request body so we
    // can diagnose 400 validation errors (wrong field name, dollars vs cents
    // mismatch, etc.). Sensitive fields like card numbers never flow through
    // this layer — only ids and amounts.
    // eslint-disable-next-line no-console
    console.error(
      `[lunarpay] ${method} ${path} → ${res.status} (${elapsedMs}ms)`,
      { request: body, response: json },
    );
    throw new LunarPayError(msg, res.status, json);
  }

  // Log successful calls at info level so we have a paper trail too.
  // eslint-disable-next-line no-console
  console.info(`[lunarpay] ${method} ${path} → ${res.status} (${elapsedMs}ms)`);
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ---------- Types (trimmed; based on LunarPay API docs) ----------

export type LPCustomer = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  amountAcum?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type LPPaymentMethod = {
  id: number;
  sourceType: "cc" | "ach";
  bankType?: "checking" | "savings" | null;
  lastDigits?: string;
  nameHolder?: string;
  isDefault?: boolean;
  expMonth?: string;
  expYear?: string;
  createdAt?: string;
};

export type LPCharge = {
  id: string;
  amount: number;
  status: "paid" | "pending" | "refunded" | "failed";
  paymentMethod: "cc" | "ach";
  customerId: number;
  paymentMethodId: number;
  fortisTransactionId?: string;
  description?: string;
  createdAt?: string;
};

export type LPSubscription = {
  id: number;
  customerId: number;
  paymentMethodId: number;
  amount: number;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  status: "active" | "cancelled";
  startOn?: string;
  nextPaymentOn?: string;
  createdAt?: string;
};

export type LPPaymentScheduleItem = {
  id: number;
  amount: number;
  date: string;
  status: "pending" | "paid" | "failed" | "cancelled";
};

export type LPPaymentSchedule = {
  id: number;
  customerId: number;
  paymentMethodId: number;
  status: "active" | "completed" | "cancelled";
  totalAmount: number;
  paidAmount: number;
  paymentsTotal: number;
  paymentsCompleted: number;
  payments: LPPaymentScheduleItem[];
  description?: string;
};

export type LPCheckoutSession = {
  id: number;
  token: string;
  url: string;
  status: "open" | "completed" | "expired";
  amount: number;
  payment_methods: string[];
  expires_at?: string;
  transaction_id?: number;
  paid_at?: string;
};

// ---------- Endpoints ----------

export const lunarpay = {
  // CUSTOMERS
  createCustomer(input: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  }) {
    return request<{ data: LPCustomer; created: boolean }>(
      "POST",
      "/api/v1/customers",
      input,
    );
  },
  updateCustomer(
    id: number,
    input: { firstName?: string; lastName?: string; email?: string; phone?: string },
  ) {
    return request<{ data: LPCustomer }>("PUT", `/api/v1/customers/${id}`, input);
  },
  getCustomer(id: number) {
    return request<{ data: LPCustomer }>("GET", `/api/v1/customers/${id}`);
  },

  // PAYMENT METHODS
  //
  // Two ways to save a card:
  //  - tokenizeId (preferred): account vault ID from a `tokenization` intention.
  //                            NO money changes hands — not even a $0.01 auth.
  //  - ticketId (legacy):      ticket ID from a `hasRecurring: true` intention.
  //                            Triggers a $0.01 auth + refund visible to the
  //                            customer. Avoid unless you must.
  savePaymentMethod(
    customerId: number,
    input: {
      tokenizeId?: string;
      ticketId?: string;
      paymentMethod?: "cc" | "ach";
      nameHolder?: string;
      setDefault?: boolean;
      // Optional metadata Fortis returns alongside tokenize_success.
      lastFour?: string;
      expMonth?: string;
      expYear?: string;
    },
  ) {
    return request<{ data: LPPaymentMethod }>(
      "POST",
      `/api/v1/customers/${customerId}/payment-methods`,
      input,
    );
  },
  listPaymentMethods(customerId: number) {
    return request<{ data: LPPaymentMethod[] }>(
      "GET",
      `/api/v1/customers/${customerId}/payment-methods`,
    );
  },
  deletePaymentMethod(customerId: number, pmId: number) {
    return request<{ success?: boolean }>(
      "DELETE",
      `/api/v1/customers/${customerId}/payment-methods/${pmId}`,
    );
  },

  // CHARGES
  createCharge(input: {
    customerId: number;
    paymentMethodId: number;
    amount: number;
    description?: string;
    capture?: boolean;
  }) {
    // LunarPay rejects non-integer amounts with "Amount must be an integer
    // (in cents)". Math.round here is defensive in case any caller computed
    // amount via a non-integer expression.
    return request<{ data: LPCharge }>("POST", "/api/v1/charges", {
      ...input,
      amount: Math.round(input.amount),
    });
  },
  captureCharge(chargeId: string, amount?: number) {
    // Captures a previously authorized hold. Pass amount to partially capture.
    return request<{ data: LPCharge }>(
      "POST",
      `/api/v1/charges/${chargeId}/capture`,
      amount ? { amount } : undefined,
    );
  },
  voidCharge(chargeId: string) {
    // Releases an authorized hold without charging.
    return request<{ success: boolean }>(
      "POST",
      `/api/v1/charges/${chargeId}/void`,
    );
  },
  refundCharge(chargeId: string, amount?: number) {
    return request<{
      data: {
        chargeId: string;
        refundedAmount: number;
        fullRefund: boolean;
        status: string;
      };
    }>(
      "POST",
      `/api/v1/charges/${chargeId}/refund`,
      amount ? { amount } : undefined,
    );
  },

  // SUBSCRIPTIONS
  createSubscription(input: {
    customerId: number;
    paymentMethodId: number;
    amount: number;
    frequency: "weekly" | "monthly" | "quarterly" | "yearly";
    startOn?: string;
    trial?: boolean;
  }) {
    return request<{ data: LPSubscription }>(
      "POST",
      "/api/v1/subscriptions",
      { ...input, amount: Math.round(input.amount) },
    );
  },
  updateSubscription(
    id: number,
    input: {
      amount?: number;
      frequency?: "weekly" | "monthly" | "quarterly" | "yearly";
      nextPaymentOn?: string;
    },
  ) {
    return request<{ data: LPSubscription }>(
      "PATCH",
      `/api/v1/subscriptions/${id}`,
      input,
    );
  },
  getSubscription(id: number) {
    return request<{ data: LPSubscription }>("GET", `/api/v1/subscriptions/${id}`);
  },
  cancelSubscription(id: number) {
    return request<{ success: boolean; status: string }>(
      "DELETE",
      `/api/v1/subscriptions/${id}`,
    );
  },

  // PAYMENT SCHEDULES
  createSchedule(input: {
    customerId: number;
    paymentMethodId: number;
    description?: string;
    // `date` is a plain YYYY-MM-DD string (NOT a datetime), per playbook.
    payments: { amount: number; date: string }[];
  }) {
    return request<{ data: LPPaymentSchedule }>(
      "POST",
      "/api/v1/payment-schedules",
      {
        ...input,
        payments: input.payments.map((p) => ({
          amount: Math.round(p.amount),
          date: p.date,
        })),
      },
    );
  },
  getSchedule(id: number) {
    return request<{ data: LPPaymentSchedule }>(
      "GET",
      `/api/v1/payment-schedules/${id}`,
    );
  },
  cancelSchedule(id: number) {
    return request<{ success?: boolean }>(
      "DELETE",
      `/api/v1/payment-schedules/${id}`,
    );
  },

  // HOSTED CHECKOUT (used for invoice / payment links)
  createCheckoutSession(input: {
    amount: number; // DOLLARS not cents here per LP docs
    description?: string;
    customer_email?: string;
    customer_name?: string;
    payment_methods?: ("cc" | "ach")[];
    mode?: "payment" | "subscription" | "installments";
    recurring?: {
      frequency: "weekly" | "monthly" | "quarterly" | "yearly";
      amount?: number;
      start_on?: string;
      trial?: boolean;
    };
    installments?: {
      count: number;
      frequency: "weekly" | "monthly" | "quarterly" | "yearly";
      amount?: number;
      start_on?: string;
    };
    success_url: string;
    cancel_url?: string;
    metadata?: Record<string, string | number | boolean | null>;
    expires_in?: number;
  }) {
    return request<LPCheckoutSession>(
      "POST",
      "/api/v1/checkout/sessions",
      input,
    );
  },
  getCheckoutSession(id: number) {
    return request<LPCheckoutSession>(
      "GET",
      `/api/v1/checkout/sessions/${id}`,
    );
  },
};
