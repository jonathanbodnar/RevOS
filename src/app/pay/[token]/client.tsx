"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Public payment-link page client.
 *
 * Flow depends on the intention type returned by the server:
 *
 * "transaction" (one-time payment):
 *   Fortis charges the card in the iframe. On `done`, we POST
 *   { transactionId } to our backend, which records the charge — it does NOT
 *   call the LunarPay charge API again (double-charge would occur).
 *
 * "tokenization" (trial subs, deferred-start installments, save-card):
 *   Fortis vaults the card — NO $0.01 verification charge. On
 *   `tokenize_success`, we POST { tokenizeId, lastFour, expMonth, expYear }
 *   so the backend can create the sub / schedule against the vault id.
 *
 * "sale" (sub starting today, combined w/ setup fee, installments w/ first
 * payment today):
 *   Fortis charges the day-of amount AND vaults the card in one shot. We
 *   wait for BOTH `done` (transactionId) and `tokenize_success` (tokenizeId)
 *   then submit both together — backend records the charge and uses the
 *   vault id for recurring/scheduled payments.
 */

type Status = "loading" | "ready" | "submitting" | "done" | "error" | "sdk-missing";

interface FortisDonePayload {
  data?: {
    id?: string;
    account_holder_name?: string;
  };
}

interface FortisTokenizePayload {
  id?: string;
  last_four?: string;
  exp_date?: string; // "MMYY"
  account_holder_name?: string;
}

interface FortisElementsInstance {
  create(params: {
    container: HTMLElement | string;
    environment?: "sandbox" | "production";
    showSubmitButton?: boolean;
    showReceipt?: boolean;
    hideAmount?: boolean;
    [key: string]: unknown;
  }): void;
  on(event: string, cb: (payload: unknown) => void): void;
  submit(): void;
}

type WindowWithCommerce = Window & {
  Commerce?: {
    elements: new (token: string) => FortisElementsInstance;
  };
};

export function PayClient({
  token,
  mode,
  clinicId,
}: {
  token: string;
  mode: "payment" | "subscription" | "combined" | "installments";
  clinicId?: string;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  const formRef = useRef({ email, firstName, lastName, phone });
  formRef.current = { email, firstName, lastName, phone };

  const mountRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<FortisElementsInstance | null>(null);
  // Determines which Fortis events to listen for and what to send to backend.
  const intentionTypeRef = useRef<"transaction" | "tokenization" | "sale">(
    "tokenization",
  );

  // Buffer the two IDs Fortis may emit (one or both, depending on intention).
  const pendingRef = useRef<{
    transactionId?: string;
    tokenizeId?: string;
    lastFour?: string;
    expMonth?: string;
    expYear?: string;
    submitted?: boolean;
  }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/payment-link/${token}/intention`,
          { method: "POST" },
        );
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || "Could not initialize form");
        }
        const intention = (await res.json()) as {
          clientToken: string;
          intentionType?: "transaction" | "tokenization" | "sale";
        };
        intentionTypeRef.current = intention.intentionType ?? "tokenization";

        await loadScript(
          process.env.NEXT_PUBLIC_FORTIS_ELEMENTS_URL ||
            "https://js.fortis.tech/commercejs-v1.0.0.min.js",
        );
        if (cancelled) return;

        const Commerce = (window as WindowWithCommerce).Commerce;
        if (!Commerce?.elements) {
          setStatus("sdk-missing");
          return;
        }

        const elements = new Commerce.elements(intention.clientToken);

        const submitIfReady = async () => {
          const p = pendingRef.current;
          if (p.submitted) return;
          const type = intentionTypeRef.current;
          // Decide whether we have enough info to submit yet.
          const ready =
            (type === "transaction" && !!p.transactionId) ||
            (type === "tokenization" && !!p.tokenizeId) ||
            (type === "sale" && !!p.transactionId && !!p.tokenizeId);
          if (!ready) return;
          p.submitted = true;

          const { email, firstName, lastName, phone } = formRef.current;
          if (!email || !firstName || !lastName) {
            setStatus("error");
            setError("Please fill in your name and email above.");
            p.submitted = false;
            return;
          }
          setStatus("submitting");
          const submit = await fetch(`/api/public/payment-link/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactionId: p.transactionId,
              tokenizeId: p.tokenizeId,
              lastFour: p.lastFour,
              expMonth: p.expMonth,
              expYear: p.expYear,
              paymentMethod: "cc",
              email,
              firstName,
              lastName,
              phone: phone || undefined,
              clinicId: clinicId || undefined,
            }),
          });
          if (!submit.ok) {
            const d = (await submit.json().catch(() => ({}))) as { error?: string };
            setStatus("error");
            setError(d.error || "Payment failed.");
            p.submitted = false;
            return;
          }
          setStatus("done");
        };

        // `done` fires for both "transaction" and "sale" intentions; carries
        // the transaction id of the charge Fortis just ran in the iframe.
        elements.on("done", async (payload: unknown) => {
          const p = payload as FortisDonePayload;
          const id = p.data?.id;
          if (id) {
            pendingRef.current.transactionId = id;
            await submitIfReady();
          }
        });

        // `tokenize_success` fires for "tokenization" and "sale" intentions;
        // carries the vaulted account id + card metadata.
        elements.on("tokenize_success", async (payload: unknown) => {
          const p = (payload ?? {}) as FortisTokenizePayload;
          if (!p.id) return;
          pendingRef.current.tokenizeId = p.id;
          pendingRef.current.lastFour = p.last_four;
          pendingRef.current.expMonth = p.exp_date?.slice(0, 2);
          pendingRef.current.expYear = p.exp_date?.slice(2);
          await submitIfReady();
        });

        elements.on("error", (payload: unknown) => {
          const p = (payload ?? {}) as { message?: string };
          setStatus("error");
          setError(p.message || "Card entry failed.");
        });

        if (mountRef.current) {
          elements.create({
            container: mountRef.current,
            environment:
              (process.env.NEXT_PUBLIC_FORTIS_ENVIRONMENT as
                | "sandbox"
                | "production") || "production",
            showSubmitButton: false,
            showReceipt: false,
          });
          elementsRef.current = elements;
        }

        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Error";
        if (msg === "load failed") setStatus("sdk-missing");
        else {
          setStatus("error");
          setError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "done") {
    return (
      <div className="text-center py-6">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 mb-3">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-1">
          {mode === "payment" ? "Payment received" : "Subscription started"}
        </h2>
        <p className="text-sm text-slate-500">
          Thanks! You can close this window.
        </p>
      </div>
    );
  }

  if (status === "sdk-missing") {
    return (
      <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md p-3">
        The secure payment form couldn&apos;t load. Please contact the clinic.
      </div>
    );
  }

  const fieldsDisabled = status === "submitting";

  function handlePay() {
    if (status !== "ready") return;
    const { email, firstName, lastName } = formRef.current;
    if (!email || !firstName || !lastName) {
      setStatus("error");
      setError("Please fill in your name and email above.");
      return;
    }
    setError(null);
    elementsRef.current?.submit();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">First name</label>
          <input
            className="input"
            placeholder="Jane"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={fieldsDisabled}
            required
          />
        </div>
        <div>
          <label className="label">Last name</label>
          <input
            className="input"
            placeholder="Doe"
            autoComplete="family-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={fieldsDisabled}
            required
          />
        </div>
      </div>

      <div>
        <label className="label">Email</label>
        <input
          type="email"
          className="input"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={fieldsDisabled}
          required
        />
      </div>

      <div>
        <label className="label">Phone (optional)</label>
        <input
          type="tel"
          className="input"
          placeholder="+1 (555) 555-5555"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={fieldsDisabled}
        />
      </div>

      <div className="border-t border-slate-200 pt-4">
        <label className="label">Card details</label>

        {status === "loading" && (
          <div className="text-sm text-slate-500 py-8 text-center">
            Loading secure form…
          </div>
        )}

        {/* Outer clip wrapper — hides the "Payment Info" header rendered by
            the Fortis iframe while keeping all input fields fully visible. */}
        <div
          className={
            status === "ready" || status === "submitting"
              ? "rounded-lg border border-slate-200 overflow-hidden"
              : "hidden"
          }
        >
          <div
            ref={mountRef}
            style={{ marginTop: -72, marginBottom: -56 }}
          />
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md p-3 mt-3">
            {error}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={handlePay}
        disabled={status !== "ready"}
        className="btn-primary w-full mt-2"
      >
        {status === "submitting" ? "Processing…" : "Pay now"}
      </button>
    </div>
  );
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-src="${src}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("load failed")));
    document.head.appendChild(s);
  });
}
