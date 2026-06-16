"use client";

import { useEffect, useRef, useState } from "react";
import { calcFee, FEE_LABEL } from "@/lib/fees";
import {
  MASTER_SUBSCRIPTION_CENTS,
  MASTER_SUBSCRIPTION_DEFAULT_DAYS,
} from "@/lib/master-link";

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

function toCents(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const dollars = parseFloat(cleaned);
  if (Number.isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

function defaultSubDateStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + MASTER_SUBSCRIPTION_DEFAULT_DAYS);
  return d.toISOString().slice(0, 10);
}

function fmtMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function PayClient({
  token,
  mode,
  clinicId,
  implementor,
  implementorOptions = [],
}: {
  token: string;
  mode: "payment" | "subscription" | "combined" | "installments" | "master";
  clinicId?: string;
  implementor?: string;
  implementorOptions?: string[];
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // Master (configurable) link state.
  const isMaster = mode === "master";
  const [downPayment, setDownPayment] = useState("");
  const [splitDown, setSplitDown] = useState(false);
  const [firstAmount, setFirstAmount] = useState(""); // amount due today when split
  const [secondDate, setSecondDate] = useState("");
  // When on, the (first) down payment is scheduled for `firstDate` instead of
  // being charged today.
  const [scheduleFirst, setScheduleFirst] = useState(false);
  const [firstDate, setFirstDate] = useState("");
  // Care credit = clinic-financed, logged but NOT charged here.
  const [firstCareCredit, setFirstCareCredit] = useState(false);
  const [secondCareCredit, setSecondCareCredit] = useState(false);
  const [enableSub, setEnableSub] = useState(false);
  const [subDate, setSubDate] = useState(defaultSubDateStr());
  // Selected implementor (master link dropdown). Defaults to the ?implementor= tag.
  const [selectedImplementor, setSelectedImplementor] = useState(implementor ?? "");

  const formRef = useRef({ email, firstName, lastName, phone });
  formRef.current = { email, firstName, lastName, phone };

  const implementorRef = useRef(selectedImplementor);
  implementorRef.current = selectedImplementor;

  const masterRef = useRef({ downPayment, splitDown, firstAmount, secondDate, scheduleFirst, firstDate, firstCareCredit, secondCareCredit, enableSub, subDate });
  masterRef.current = { downPayment, splitDown, firstAmount, secondDate, scheduleFirst, firstDate, firstCareCredit, secondCareCredit, enableSub, subDate };

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

          // Master link: validate the payer's configuration before submitting.
          let masterPayload:
            | {
                downPaymentCents: number;
                split: boolean;
                firstPaymentCents?: number;
                firstPaymentDate?: string;
                secondPaymentDate?: string;
                firstIsCareCredit?: boolean;
                secondIsCareCredit?: boolean;
                subscription: boolean;
                subscriptionDate?: string;
              }
            | undefined;
          if (isMaster) {
            const m = masterRef.current;
            // Down payment may be $0 (blank counts as 0) as long as a
            // subscription is enabled — e.g. start a subscription with no
            // money down. Any positive amount must still clear the $0.50 floor.
            const downCents =
              m.downPayment.trim() === "" ? 0 : toCents(m.downPayment) ?? -1;
            if (downCents < 0 || (downCents > 0 && downCents < 50)) {
              setStatus("error");
              setError("Down payment must be $0 or at least $0.50.");
              p.submitted = false;
              return;
            }
            if (downCents === 0 && !m.enableSub) {
              setStatus("error");
              setError("Enter a down payment or turn on the subscription.");
              p.submitted = false;
              return;
            }
            const useSplit = m.splitDown && downCents > 0;
            const firstCC = downCents > 0 && m.firstCareCredit;
            const secondCC = useSplit && m.secondCareCredit;
            let firstCents: number | undefined;
            if (useSplit) {
              if (downCents < 100) {
                setStatus("error");
                setError("A split down payment must be at least $1.00 total.");
                p.submitted = false;
                return;
              }
              // Amount due today: defaults to half if left blank.
              firstCents =
                m.firstAmount.trim() === ""
                  ? Math.floor(downCents / 2)
                  : toCents(m.firstAmount) ?? -1;
              if (firstCents < 50 || downCents - firstCents < 50) {
                setStatus("error");
                setError(
                  "Each payment must be at least $0.50, and the first payment must be less than the total.",
                );
                p.submitted = false;
                return;
              }
              // A second-payment date is only needed if it's actually charged
              // (not care credit).
              if (!secondCC && !m.secondDate) {
                setStatus("error");
                setError("Please choose a date for the second payment.");
                p.submitted = false;
                return;
              }
            }
            // Optionally defer the first/down payment to a chosen date — not
            // applicable when the first payment is care credit (never charged).
            const deferFirst = m.scheduleFirst && downCents > 0 && !firstCC;
            if (deferFirst && !m.firstDate) {
              setStatus("error");
              setError("Please choose a date for the first payment.");
              p.submitted = false;
              return;
            }
            masterPayload = {
              downPaymentCents: downCents,
              split: useSplit,
              firstPaymentCents: useSplit ? firstCents : undefined,
              firstPaymentDate: deferFirst ? m.firstDate : undefined,
              secondPaymentDate: useSplit && !secondCC ? m.secondDate : undefined,
              firstIsCareCredit: firstCC,
              secondIsCareCredit: secondCC,
              subscription: m.enableSub,
              subscriptionDate: m.enableSub ? m.subDate : undefined,
            };
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
                implementor: implementorRef.current || implementor || undefined,
                master: masterPayload,
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
          {mode === "payment" || mode === "master"
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

  // Live master-link summary.
  const downCents = isMaster ? toCents(downPayment) ?? 0 : 0;
  const firstBaseCents = splitDown
    ? firstAmount.trim() === ""
      ? Math.floor(downCents / 2)
      : toCents(firstAmount) ?? 0
    : downCents;
  const secondBaseCents = splitDown ? Math.max(0, downCents - firstBaseCents) : 0;
  const firstCC = downCents > 0 && firstCareCredit;
  const secondCC = splitDown && downCents > 0 && secondCareCredit;
  const firstScheduled = scheduleFirst && downCents > 0 && !firstCC;
  const firstTotalCents = firstBaseCents >= 50 ? calcFee(firstBaseCents).totalCents : 0;
  const dueTodayCents = firstScheduled || firstCC ? 0 : firstTotalCents;
  const secondTotalCents =
    !secondCC && secondBaseCents >= 50 ? calcFee(secondBaseCents).totalCents : 0;
  // Care-credit amounts are logged at their base value (no processing fee).
  const careCreditCents = (firstCC ? firstBaseCents : 0) + (secondCC ? secondBaseCents : 0);
  const subTotalCents = calcFee(MASTER_SUBSCRIPTION_CENTS).totalCents;

  return (
    <div className="space-y-4">
      {isMaster && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          {(implementorOptions.length > 0 || implementor) && (
            <div>
              <label className="label">Implementor</label>
              <select
                className="input"
                value={selectedImplementor}
                onChange={(e) => setSelectedImplementor(e.target.value)}
                disabled={fieldsDisabled}
              >
                <option value="">— Select —</option>
                {/* Preserve a ?implementor= tag value even if not in the list */}
                {implementor && !implementorOptions.includes(implementor) && (
                  <option value={implementor}>{implementor}</option>
                )}
                {implementorOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Down payment (optional)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
              <input
                className="input pl-7"
                inputMode="decimal"
                placeholder="0.00"
                value={downPayment}
                onChange={(e) => setDownPayment(e.target.value)}
                disabled={fieldsDisabled}
              />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Leave at $0 to start a subscription with no money down.
            </p>
          </div>

          {/* Care-credit toggle for a non-split down payment */}
          {downCents > 0 && !splitDown && (
            <button
              type="button"
              onClick={() => !fieldsDisabled && setFirstCareCredit((v) => !v)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span className="text-sm text-slate-700">
                Down payment is care credit (financed — not charged here)
              </span>
              <Switch on={firstCareCredit} />
            </button>
          )}

          {/* Split toggle — only relevant with a down payment */}
          {downCents > 0 && (
          <button
            type="button"
            onClick={() => !fieldsDisabled && setSplitDown((v) => !v)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="text-sm text-slate-700">
              Split the down payment into two payments
            </span>
            <Switch on={splitDown} />
          </button>
          )}
          {splitDown && downCents > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">First payment{firstCC ? " (care credit)" : ""}</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                    <input
                      className="input pl-7"
                      inputMode="decimal"
                      placeholder={
                        downCents >= 100 ? (downCents / 200).toFixed(2) : "0.00"
                      }
                      value={firstAmount}
                      onChange={(e) => setFirstAmount(e.target.value)}
                      disabled={fieldsDisabled}
                    />
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Remainder: {fmtMoney(Math.max(0, secondBaseCents))}
                  </p>
                </div>
                <div>
                  <label className="label">Second payment date</label>
                  <input
                    type="date"
                    className="input disabled:opacity-50"
                    value={secondDate}
                    min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                    onChange={(e) => setSecondDate(e.target.value)}
                    disabled={fieldsDisabled || secondCC}
                  />
                  {secondCC && (
                    <p className="text-xs text-slate-500 mt-1">Care credit — no charge.</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => !fieldsDisabled && setFirstCareCredit((v) => !v)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span className="text-sm text-slate-700">First payment is care credit</span>
                <Switch on={firstCareCredit} />
              </button>
              <button
                type="button"
                onClick={() => !fieldsDisabled && setSecondCareCredit((v) => !v)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span className="text-sm text-slate-700">Second payment is care credit</span>
                <Switch on={secondCareCredit} />
              </button>
            </div>
          )}

          {/* Schedule the first/down payment for later instead of charging now */}
          {downCents > 0 && !firstCC && (
            <>
              <button
                type="button"
                onClick={() => !fieldsDisabled && setScheduleFirst((v) => !v)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span className="text-sm text-slate-700">
                  Schedule the {splitDown ? "first " : "down "}payment for later
                </span>
                <Switch on={scheduleFirst} />
              </button>
              {scheduleFirst && (
                <div>
                  <label className="label">
                    {splitDown ? "First payment date" : "Down payment date"}
                  </label>
                  <input
                    type="date"
                    className="input"
                    value={firstDate}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setFirstDate(e.target.value)}
                    disabled={fieldsDisabled}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Nothing is charged today — this payment runs on the date you
                    choose.
                  </p>
                </div>
              )}
            </>
          )}

          {/* Subscription toggle */}
          <button
            type="button"
            onClick={() => !fieldsDisabled && setEnableSub((v) => !v)}
            className="flex w-full items-center justify-between gap-3 text-left border-t border-slate-200 pt-3"
          >
            <span className="text-sm text-slate-700">
              Add {fmtMoney(MASTER_SUBSCRIPTION_CENTS)}/month subscription
            </span>
            <Switch on={enableSub} />
          </button>
          {enableSub && (
            <div>
              <label className="label">First subscription charge</label>
              <input
                type="date"
                className="input"
                value={subDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setSubDate(e.target.value)}
                disabled={fieldsDisabled}
              />
            </div>
          )}

          {/* Live summary */}
          {(downCents >= 50 || enableSub || careCreditCents > 0) && (
            <ul className="text-sm text-slate-600 space-y-1 border-t border-slate-200 pt-3">
              <li className="flex justify-between">
                <span>Due today{splitDown && downCents > 0 && !firstScheduled ? " (1st payment)" : ""}</span>
                <span className="tabular-nums font-medium text-slate-900">
                  {fmtMoney(dueTodayCents)}
                </span>
              </li>
              {firstScheduled && firstTotalCents > 0 && (
                <li className="flex justify-between text-slate-500 text-xs">
                  <span>
                    {splitDown ? "1st payment" : "Down payment"}
                    {firstDate ? ` · ${firstDate}` : ""}
                  </span>
                  <span className="tabular-nums">{fmtMoney(firstTotalCents)}</span>
                </li>
              )}
              {splitDown && downCents > 0 && secondTotalCents > 0 && (
                <li className="flex justify-between text-slate-500 text-xs">
                  <span>2nd payment{secondDate ? ` · ${secondDate}` : ""}</span>
                  <span className="tabular-nums">{fmtMoney(secondTotalCents)}</span>
                </li>
              )}
              {careCreditCents > 0 && (
                <li className="flex justify-between text-slate-500 text-xs">
                  <span>Care credit (financed · not charged)</span>
                  <span className="tabular-nums">{fmtMoney(careCreditCents)}</span>
                </li>
              )}
              {enableSub && (
                <li className="flex justify-between text-slate-500 text-xs">
                  <span>Subscription{subDate ? ` · from ${subDate}` : ""}</span>
                  <span className="tabular-nums">{fmtMoney(subTotalCents)}/mo</span>
                </li>
              )}
              <li className="text-[11px] text-slate-400 pt-1">
                Includes {FEE_LABEL} processing fee on each payment.
              </li>
            </ul>
          )}
        </div>
      )}

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

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-brand-600" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </span>
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
