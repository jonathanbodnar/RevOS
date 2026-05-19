"use client";

import { useEffect, useRef, useState } from "react";

/**
 * In-admin "add card" using Fortis Elements.
 *
 * Flow:
 *  1) Ask the server for a Fortis `clientToken` via LunarPay /intentions
 *     with `action: "tokenization"` so the card is vaulted with no $0.01
 *     verification charge visible to the customer.
 *  2) Load the Fortis Elements SDK from `NEXT_PUBLIC_FORTIS_ELEMENTS_URL`.
 *  3) Mount the Elements iframe; on `tokenize_success`, send the account
 *     vault id (+ card metadata) to our backend, which calls LunarPay to
 *     attach the saved payment method to the customer.
 *
 * Fortis Elements' SDK shape (CommerceHub) is stable, but the exact CDN URL
 * may vary by merchant. If the SDK fails to load, we show a helpful message
 * and direct the clinic admin to use the "Send link to customer" fallback.
 */
type IntentionResponse = {
  clientToken: string;
  intentionType: "tokenization" | "transaction";
  paymentMethod: "cc" | "ach" | "any";
  locationId?: string;
  environment?: string;
};

declare global {
  interface Window {
    Commerce?: {
      elements: new (token: string) => FortisElements;
    };
  }
}

interface FortisElements {
  create(params: {
    container: HTMLElement | string;
    environment?: "sandbox" | "production";
    theme?: "default" | "dark";
    showSubmitButton?: boolean;
    showReceipt?: boolean;
    hideAmount?: boolean;
    [key: string]: unknown;
  }): void;
  on(event: string, cb: (payload: unknown) => void): void;
  submit(): void;
}

export function AddCardModal({
  customerId,
  onClose,
  onSaved,
}: {
  customerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<
    "loading" | "ready" | "sdk-missing" | "saving" | "error"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<FortisElements | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1) Get clientToken from our server.
        const tokenRes = await fetch(
          `/api/clinic/customers/${customerId}/intention`,
          { method: "POST" },
        );
        if (!tokenRes.ok) {
          const d = (await tokenRes.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(d.error || "Failed to create intention");
        }
        const intention = (await tokenRes.json()) as IntentionResponse;

        // 2) Load Fortis Elements SDK if not already loaded.
        await loadScript(
          process.env.NEXT_PUBLIC_FORTIS_ELEMENTS_URL ||
            "https://js.fortis.tech/commercejs-v1.0.0.min.js",
        ).catch(() => {
          throw new Error("SDK_LOAD_FAILED");
        });

        if (cancelled) return;
        if (!window.Commerce?.elements) {
          setStatus("sdk-missing");
          return;
        }

        // 3) Create elements instance and wire events.
        const elements = new window.Commerce.elements(intention.clientToken);

        let saved = false;
        const saveCard = async (
          tokenizeId: string,
          lastFour?: string,
          expDate?: string,
          nameHolder?: string,
        ) => {
          if (saved) return;
          saved = true;
          setStatus("saving");
          try {
            const saveRes = await fetch(
              `/api/clinic/customers/${customerId}/payment-methods`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  tokenizeId,
                  paymentMethod: "cc",
                  lastFour,
                  expMonth: expDate?.slice(0, 2),
                  expYear: expDate?.slice(2),
                  nameHolder,
                }),
              },
            );
            const body = (await saveRes.json().catch(() => ({}))) as {
              data?: { id?: string };
              error?: string;
            };
            if (!saveRes.ok || !body.data?.id) {
              setStatus("error");
              setError(body.error || "Failed to save card.");
              saved = false;
              return;
            }
            onSaved();
          } catch {
            setStatus("error");
            setError("Network error. Please try again.");
            saved = false;
          }
        };

        // Per LunarPay playbook: tokenization intentions fire `done` with
        // data.id = account_vault_id. Some SDK versions also emit
        // `tokenize_success`.
        elements.on("done", async (payload) => {
          // eslint-disable-next-line no-console
          console.info("[fortis] done", payload);
          const p = (payload ?? {}) as {
            data?: {
              id?: string;
              last_four?: string;
              exp_date?: string;
              account_holder_name?: string;
              account?: { last_four?: string; exp_date?: string };
            };
          };
          const id = p.data?.id;
          if (!id) {
            setStatus("error");
            setError("Card not saved. Please try again.");
            return;
          }
          await saveCard(
            id,
            p.data?.last_four ?? p.data?.account?.last_four,
            p.data?.exp_date ?? p.data?.account?.exp_date,
            p.data?.account_holder_name,
          );
        });

        elements.on("tokenize_success", async (payload) => {
          // eslint-disable-next-line no-console
          console.info("[fortis] tokenize_success", payload);
          const p = (payload ?? {}) as {
            id?: string;
            last_four?: string;
            exp_date?: string;
            account_holder_name?: string;
          };
          if (!p.id) return;
          await saveCard(p.id, p.last_four, p.exp_date, p.account_holder_name);
        });

        elements.on("error", (payload) => {
          // eslint-disable-next-line no-console
          console.error("[fortis] error", payload);
          const p = payload as { message?: string };
          setStatus("error");
          setError(p.message || "Card entry failed.");
        });

        // 4) Mount the iframe into the container div.
        if (mountRef.current) {
          elements.create({
            container: mountRef.current,
            environment:
              (process.env.NEXT_PUBLIC_FORTIS_ENVIRONMENT as
                | "sandbox"
                | "production") || "production",
            // Fortis ignores elements.submit() when this is false. Let
            // Fortis render its own button (playbook-compliant).
            showSubmitButton: true,
            showReceipt: false,
          });
          elementsRef.current = elements;
        }

        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "SDK_LOAD_FAILED") {
          setStatus("sdk-missing");
        } else {
          setStatus("error");
          setError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId, onSaved]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="card w-full max-w-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Add card
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Card data is sent directly to Fortis. RevOS never sees the number.
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {status === "loading" && (
          <div className="text-sm text-slate-500 py-6 text-center">
            Preparing secure card form…
          </div>
        )}

        {status === "sdk-missing" && (
          <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md p-3">
            <p className="font-medium mb-1">Fortis Elements SDK not available.</p>
            <p>
              To enable in-admin card entry, set{" "}
              <code>NEXT_PUBLIC_FORTIS_ELEMENTS_URL</code> to the Fortis Elements
              SDK URL provided by your LunarPay onboarding contact.
            </p>
            <p className="mt-2">
              In the meantime, use{" "}
              <strong>“Send link to customer”</strong> — the customer can add
              their card via a secure LunarPay-hosted page.
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md p-3">
            {error || "Something went wrong."}
          </div>
        )}

        <div
          className={
            status === "ready" || status === "saving"
              ? "rounded-lg border border-slate-200 overflow-hidden"
              : "hidden"
          }
        >
          <div ref={mountRef} style={{ marginTop: -130 }} />
        </div>

        {status === "saving" && (
          <div className="text-sm text-slate-500 py-3 text-center">Saving…</div>
        )}
      </div>
    </div>
  );
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    const existing = document.querySelector(
      `script[data-src="${src}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "1") resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("load failed")));
      }
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
