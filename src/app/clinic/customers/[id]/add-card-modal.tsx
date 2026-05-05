"use client";

import { useEffect, useRef, useState } from "react";

/**
 * In-admin "add card" using Fortis Elements.
 *
 * Flow:
 *  1) Ask the server for a Fortis `clientToken` (via LunarPay /intentions
 *     with `hasRecurring: true` so the card is saved, not just charged).
 *  2) Load the Fortis Elements SDK from `NEXT_PUBLIC_FORTIS_ELEMENTS_URL`.
 *  3) Mount the Elements iframe; when Fortis returns a `ticket_id`, send it
 *     to our backend which calls LunarPay to vault the card against the
 *     customer.
 *
 * Fortis Elements' SDK shape (CommerceHub) is stable, but the exact CDN URL
 * may vary by merchant. If the SDK fails to load, we show a helpful message
 * and direct the clinic admin to use the "Send link to customer" fallback.
 */
type IntentionResponse = {
  clientToken: string;
  intentionType: "ticket" | "transaction";
  paymentMethod: "cc" | "ach" | "any";
  locationId?: string;
  environment?: string;
};

declare global {
  interface Window {
    Commerce?: {
      elements: new (
        token: string,
        options?: Record<string, unknown>,
      ) => {
        create: (
          kind: string,
          options?: Record<string, unknown>,
        ) => {
          mount: (selector: string | HTMLElement) => void;
          on: (event: string, cb: (payload: unknown) => void) => void;
        };
      };
    };
    FortisElements?: unknown;
  }
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

        // 3) Mount.
        const elements = new window.Commerce.elements(intention.clientToken, {
          appearance: { theme: "light" },
        });
        const card = elements.create("payment", {
          fields: ["card"],
        });
        if (mountRef.current) {
          card.mount(mountRef.current);
        }
        card.on("done", async (payload) => {
          // Fortis returns a ticket_id / token here.
          const p = payload as {
            ticket_id?: string;
            ticketId?: string;
            token?: string;
            payment_method?: "cc" | "ach";
          };
          const ticketId = p.ticket_id ?? p.ticketId ?? p.token;
          if (!ticketId) {
            setStatus("error");
            setError("Card entry failed — no ticket returned.");
            return;
          }
          setStatus("saving");
          const saveRes = await fetch(
            `/api/clinic/customers/${customerId}/payment-methods`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ticketId,
                paymentMethod: p.payment_method || "cc",
              }),
            },
          );
          if (!saveRes.ok) {
            const d = (await saveRes.json().catch(() => ({}))) as {
              error?: string;
            };
            setStatus("error");
            setError(d.error || "Failed to save card.");
            return;
          }
          onSaved();
        });
        card.on("error", (payload) => {
          const p = payload as { message?: string };
          setStatus("error");
          setError(p.message || "Card entry failed.");
        });

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

        {(status === "ready" || status === "saving") && (
          <div>
            <div
              ref={mountRef}
              className="rounded-md border border-slate-200 bg-slate-50 min-h-[200px] p-3"
            />
            {status === "saving" && (
              <p className="text-xs text-slate-500 mt-3 text-center">
                Saving card…
              </p>
            )}
          </div>
        )}

        {status === "error" && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md p-3">
            {error || "Something went wrong."}
          </div>
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
