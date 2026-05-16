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

        elements.on("done", async (payload: unknown) => {
          // Fortis payload shape: { "@type": "done", "data": { "id": "<ticketId>", ... } }
          const p = payload as { data?: { id?: string } };
          const ticketId = p.data?.id;
          const paymentMethod: "cc" | "ach" = "cc";
          if (!ticketId) {
            setStatus("error");
            setError("No ticket returned.");
            return;
          }
          setStatus("saving");
          const saveRes = await fetch(`/api/public/save-card/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticketId, paymentMethod }),
          });
          if (!saveRes.ok) {
            const d = (await saveRes.json().catch(() => ({}))) as {
              error?: string;
            };
            setStatus("error");
            setError(d.error || "Failed to save card.");
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
            hideAmount: true,
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
        <div ref={mountRef} style={{ marginTop: -72 }} />
      </div>
      <button
        type="button"
        onClick={() => {
          if (status === "ready") elementsRef.current?.submit();
        }}
        disabled={status !== "ready"}
        className="btn-primary w-full"
      >
        {status === "saving" ? "Saving…" : "Save card"}
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
