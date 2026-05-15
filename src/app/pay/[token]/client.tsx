"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Public payment-link page client.
 *
 * Flow:
 *  1) Render email/name form + Fortis Elements card iframe.
 *  2) When the customer clicks our custom "Pay" button we call
 *     elements.submit() to trigger Fortis tokenisation. Fortis fires `done`
 *     with a ticketId once the card is vaulted.
 *  3) We POST { ticketId, email, firstName, lastName, phone, clinicId } to
 *     our public API; the server creates the customer, vaults the card, and
 *     runs the initial charge (and subscription, if applicable).
 *
 * showSubmitButton: false hides Fortis's built-in Pay button so we can
 * render our own styled button outside the iframe. The container wrapper uses
 * overflow:hidden + a negative top offset to clip the "Payment info" section
 * heading that Fortis renders at the top of the iframe — keeping the card
 * fields visible while hiding the redundant label.
 */

type Status = "loading" | "ready" | "submitting" | "done" | "error" | "sdk-missing";

interface FortisDonePayload {
  data?: {
    id?: string;
    account_holder_name?: string;
  };
}

interface FortisElementsInstance {
  create(params: {
    container: HTMLElement | string;
    environment?: "sandbox" | "production";
    showSubmitButton?: boolean;
    showReceipt?: boolean;
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
  mode: "payment" | "subscription" | "combined";
  clinicId?: string;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // Latest form values (used inside the Fortis `done` callback, which closes
  // over the values present when the elements instance was created).
  const formRef = useRef({ email, firstName, lastName, phone });
  formRef.current = { email, firstName, lastName, phone };

  const mountRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<FortisElementsInstance | null>(null);

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
        const intention = (await res.json()) as { clientToken: string };

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

        elements.on("done", async (payload: unknown) => {
          const p = payload as FortisDonePayload;
          const ticketId = p.data?.id;
          if (!ticketId) {
            setStatus("error");
            setError("No card token returned. Please try again.");
            return;
          }

          // Validate the form fields before submitting.
          const { email, firstName, lastName, phone } = formRef.current;
          if (!email || !firstName || !lastName) {
            setStatus("error");
            setError("Please fill in your name and email above.");
            return;
          }

          setStatus("submitting");
          const submit = await fetch(`/api/public/payment-link/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticketId,
              paymentMethod: "cc",
              email,
              firstName,
              lastName,
              phone: phone || undefined,
              clinicId: clinicId || undefined,
            }),
          });
          if (!submit.ok) {
            const d = (await submit.json().catch(() => ({}))) as {
              error?: string;
            };
            setStatus("error");
            setError(d.error || "Payment failed.");
            return;
          }
          setStatus("done");
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

        <div
          ref={mountRef}
          className={
            status === "ready" || status === "submitting"
              ? "rounded-lg border border-slate-200 overflow-hidden mt-2"
              : "hidden"
          }
        />

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
