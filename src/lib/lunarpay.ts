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
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const json = text ? safeJson(text) : {};
  if (!res.ok) {
    const msg =
      (json as { error?: string })?.error || `LunarPay ${res.status}`;
    throw new LunarPayError(msg, res.status, json);
  }
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
  savePaymentMethod(
    customerId: number,
    input: {
      ticketId: string;
      paymentMethod?: "cc" | "ach";
      nameHolder?: string;
      setDefault?: boolean;
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
  }) {
    return request<{ data: LPCharge }>("POST", "/api/v1/charges", input);
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
  }) {
    return request<{ data: LPSubscription }>(
      "POST",
      "/api/v1/subscriptions",
      input,
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
    payments: { amount: number; date: string }[];
  }) {
    return request<{ data: LPPaymentSchedule }>(
      "POST",
      "/api/v1/payment-schedules",
      input,
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
