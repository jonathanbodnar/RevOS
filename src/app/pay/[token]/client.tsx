"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Public payment-link page client.
 *
 * Two flows depending on the intention type returned by the server:
 *
 * "transaction" (one-time payment, mode === "payment"):
 *   Fortis charges the card in the iframe. On `done`, we POST
 *   { transactionId } to our backend, which records the charge.
 *
 * "tokenization" (everything else: sub / combined / installments, trial
 * or not):
 *   Fortis vaults the card — NO $0.01 verification charge. On
 *   `tokenize_success`, we POST { tokenizeId, lastFour, expMonth, expYear }
 *   so the backend can save the payment method, run the day-of charge
 *   (if any) via createCharge, then create the LunarPay subscription /
 *   schedule against the vault id.
 */

type Status = "loading" | "ready" | "submitting" | "done" | "error" | "sdk-missing";

// For BOTH transaction and tokenization intentions, Fortis fires `done`.
// The semantics of `data.id` differ:
//   - transaction intention  → data.id is the transaction id
//   - tokenization intention → data.id is the account_vault_id (= tokenizeId)
// Card metadata is also on data (last_four, exp_date) for tokenization.
interface FortisDonePayload {
  data?: {
    id?: string;
    account_holder_name?: string;
    last_four?: string;
    exp_date?: string; // "MMYY"
    account?: {
      last_four?: string;
      exp_date?: string;
    };
  };
}

interface FortisTokenizePayload {
  id?: string;
  last_four?: string;
  exp_date?: string;
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
  implementor,
}: {
  token: string;
  mode: "payment" | "subscription" | "combined" | "installments";
  clinicId?: string;
  implementor?: string;
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
  const intentionTypeRef = useRef<"transaction" | "tokenization">(
    "tokenization",
  );

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
          const d = (await res.json().catch(() => ({}))) as {
            error?: string;
            sentBody?: unknown;
            lunarPayResponse?: unknown;
          };
          // eslint-disable-next-line no-console
          console.error("[intention] init failed", d);
          throw new Error(d.error || "Could not initialize form");
        }
        const intention = (await res.json()) as {
          clientToken: string;
          intentionType?: "transaction" | "tokenization";
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
          const ready =
            (type === "transaction" && !!p.transactionId) ||
            (type === "tokenization" && !!p.tokenizeId);
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
          try {
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
                implementor: implementor || undefined,
              }),
            });
            // Require explicit { ok: true } in the response body — a 200 with
            // an error message still counts as a failure.
            const body = (await submit.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
            };
            if (!submit.ok || !body.ok) {
              setStatus("error");
              setError(body.error || "Payment failed. Please try again.");
              p.submitted = false;
              return;
            }
          } catch {
            setStatus("error");
            setError("Network error. Please check your connection and try again.");
            p.submitted = false;
            return;
          }
          setStatus("done");
        };

        // Fortis fires `done` for BOTH intention types — interpret data.id
        // based on which intention we requested.
        elements.on("done", async (payload: unknown) => {
          // eslint-disable-next-line no-console
          console.info("[fortis] done", payload);
          const p = payload as FortisDonePayload;
          const id = p.data?.id;
          if (!id) {
            setStatus("error");
            setError(
              intentionTypeRef.current === "tokenization"
                ? "Card could not be saved. Please try again."
                : "Payment could not be processed. Please try again.",
            );
            return;
          }
          if (intentionTypeRef.current === "tokenization") {
            // For tokenization intentions, data.id IS the account vault id.
            pendingRef.current.tokenizeId = id;
            const lastFour = p.data?.last_four ?? p.data?.account?.last_four;
            const expDate = p.data?.exp_date ?? p.data?.account?.exp_date;
            pendingRef.current.lastFour = lastFour;
            pendingRef.current.expMonth = expDate?.slice(0, 2);
            pendingRef.current.expYear = expDate?.slice(2);
          } else {
            pendingRef.current.transactionId = id;
          }
          await submitIfReady();
        });

        // Some SDK versions also fire `tokenize_success` for tokenization
        // intentions. Treat it as a fallback for the vault id.
        elements.on("tokenize_success", async (payload: unknown) => {
          // eslint-disable-next-line no-console
          console.info("[fortis] tokenize_success", payload);
          if (intentionTypeRef.current !== "tokenization") return;
          if (pendingRef.current.tokenizeId) return; // already captured from `done`
          const p = (payload ?? {}) as FortisTokenizePayload;
          if (!p.id) return;
          pendingRef.current.tokenizeId = p.id;
          pendingRef.current.lastFour = p.last_four;
          pendingRef.current.expMonth = p.exp_date?.slice(0, 2);
          pendingRef.current.expYear = p.exp_date?.slice(2);
          await submitIfReady();
        });

        elements.on("error", (payload: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[fortis] error", payload);
          const p = (payload ?? {}) as { message?: string };
          setStatus("error");
          setError(p.message || "Card entry failed. Please try again.");
        });

        ["submit", "ready", "validation_error"].forEach((evt) => {
          elements.on(evt, (payload: unknown) => {
            // eslint-disable-next-line no-console
            console.info(`[fortis] ${evt}`, payload);
          });
        });

        if (mountRef.current) {
          elements.create({
            container: mountRef.current,
            environment:
              (process.env.NEXT_PUBLIC_FORTIS_ENVIRONMENT as
                | "sandbox"
                | "production") || "production",
            // Per LunarPay playbook: Fortis IGNORES elements.submit() when
            // showSubmitButton is false, so we MUST let Fortis render its
            // own button — calling submit() from a custom button is a no-op.
            showSubmitButton: true,
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
          {mode === "payment"
            ? "Payment received"
            : mode === "installments"
            ? "Plan started"
            : "Subscription started"}
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

  // Soft validation hint shown above the card form when name/email aren't
  // filled — the Fortis button will trigger the flow regardless, but our
  // submitIfReady handler will surface "fill in name/email" before sending.
  const missingCustomerInfo = !email || !firstName || !lastName;

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

        {missingCustomerInfo && (status === "ready" || status === "submitting") && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-3 py-2 mb-2">
            Fill in your name and email above before submitting your card.
          </div>
        )}

        {/* Clip wrapper — crops the "Payment Info" header from the top of
            the Fortis iframe. The Fortis-rendered submit button at the
            bottom stays visible so customers can complete the payment. */}
        <div
          className={
            status === "ready" || status === "submitting"
              ? "rounded-lg border border-slate-200 overflow-hidden"
              : "hidden"
          }
        >
          <div ref={mountRef} style={{ marginTop: -130 }} />
        </div>

        {status === "submitting" && (
          <div className="text-sm text-slate-500 py-3 text-center">
            Processing payment…
          </div>
        )}

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md p-3 mt-3">
            {error}
          </div>
        )}
      </div>
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
