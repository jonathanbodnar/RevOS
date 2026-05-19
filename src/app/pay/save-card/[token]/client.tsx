"use client";

import { useEffect, useRef, useState } from "react";

interface FortisElementsSDK {
  create(params: {
    container: HTMLElement | string;
    environment?: "sandbox" | "production";
    showReceipt?: boolean;
    showSubmitButton?: boolean;
    hideAmount?: boolean;
    [key: string]: unknown;
  }): void;
  on(event: string, cb: (payload: unknown) => void): void;
  submit(): void;
}

export function SaveCardClient({ token }: { token: string }) {
  const [status, setStatus] = useState<
    "loading" | "ready" | "saving" | "done" | "error" | "sdk-missing"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<FortisElementsSDK | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/save-card/${token}/intention`, {
          method: "POST",
        });
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

        const Commerce = (window as Window & {
          Commerce?: { elements: new (token: string) => FortisElementsSDK };
        }).Commerce;
        if (!Commerce?.elements) {
          setStatus("sdk-missing");
          return;
        }

        const elements = new Commerce.elements(intention.clientToken);

        let submitted = false;
        const submitVault = async (
          tokenizeId: string,
          lastFour?: string,
          expDate?: string,
          nameHolder?: string,
        ) => {
          if (submitted) return;
          submitted = true;
          setStatus("saving");
          try {
            const saveRes = await fetch(`/api/public/save-card/${token}`, {
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
            });
            const body = (await saveRes.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
            };
            if (!saveRes.ok || !body.ok) {
              setStatus("error");
              setError(body.error || "Failed to save card.");
              submitted = false;
              return;
            }
            setStatus("done");
          } catch {
            setStatus("error");
            setError("Network error. Please try again.");
            submitted = false;
          }
        };

        // Per LunarPay playbook: tokenization intentions fire `done` with
        // data.id = account_vault_id. Some SDK versions also emit
        // `tokenize_success` — treat both as the same success signal.
        elements.on("done", async (payload: unknown) => {
          // eslint-disable-next-line no-console
          console.info("[fortis] done", payload);
          const p = payload as {
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
          await submitVault(
            id,
            p.data?.last_four ?? p.data?.account?.last_four,
            p.data?.exp_date ?? p.data?.account?.exp_date,
            p.data?.account_holder_name,
          );
        });

        elements.on("tokenize_success", async (payload: unknown) => {
          // eslint-disable-next-line no-console
          console.info("[fortis] tokenize_success", payload);
          const p = (payload ?? {}) as {
            id?: string;
            last_four?: string;
            exp_date?: string;
            account_holder_name?: string;
          };
          if (!p.id) return;
          await submitVault(p.id, p.last_four, p.exp_date, p.account_holder_name);
        });

        elements.on("error", (payload: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[fortis] error", payload);
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
            // Fortis ignores elements.submit() when this is false, so let
            // Fortis render its own button (playbook-compliant).
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
      <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md p-3 text-center">
        Payment method saved. You can close this window.
      </div>
    );
  }
  if (status === "sdk-missing") {
    return (
      <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md p-3">
        The secure payment form couldn't load. Please contact the clinic.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {status === "loading" && (
        <div className="text-sm text-slate-500 py-8 text-center">
          Loading secure form…
        </div>
      )}
      {status === "error" && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md p-3">
          {error}
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
