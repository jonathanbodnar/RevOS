/**
 * Per-clinic call rules: defaults, validation, and the calling-hours check.
 *
 * Defaults are the Dial Desk prototype's settings. The legal guard rails the
 * Rules page cannot loosen: never on Sunday, never before 8 AM or after 9 PM
 * clinic time, at most 10 calls per person per 24 hours (Florida and Oklahoma
 * cap sales calls at 3, which is the default). Isomorphic.
 */
import { z } from "zod";
import { dayInTz, dow, isWorkDay, minuteLabel, minutesInTz, US_TIMEZONES } from "./time";

export type CallRulesConfig = {
  timezone: string;
  dailyTarget: number;
  maxAttempts: number;
  spacingDays: number;
  workDays: number[];
  freshDays: number[];
  freshFloor: number;
  callStartMinute: number;
  callEndMinute: number;
  maxCallsPer24h: number;
  doubleDial: boolean;
  rebookAttempts: number;
  recycleDays: number;
  confirm48h: boolean;
  confirm24h: boolean;
  confirmDayOf: boolean;
  ringSeconds: number;
  skipVoicemail: boolean;
  autoDialConsentOnly: boolean;
};

export const DEFAULT_RULES: CallRulesConfig = {
  timezone: "America/Chicago",
  dailyTarget: 200,
  maxAttempts: 4,
  spacingDays: 2,
  workDays: [1, 2, 3, 4, 5],
  freshDays: [2, 3, 4, 5],
  freshFloor: 40,
  callStartMinute: 9 * 60,
  callEndMinute: 19 * 60,
  maxCallsPer24h: 3,
  doubleDial: true,
  rebookAttempts: 3,
  recycleDays: 0,
  confirm48h: true,
  confirm24h: true,
  confirmDayOf: true,
  ringSeconds: 25,
  skipVoicemail: false,
  autoDialConsentOnly: true,
};

/** Earliest start and latest end the Rules page allows (clinic time). */
export const EARLIEST_MINUTE = 8 * 60;
export const LATEST_MINUTE = 21 * 60;

const weekdayList = z
  .array(z.number().int().min(1).max(6))
  .max(6)
  .transform((a) => Array.from(new Set(a)).sort((x, y) => x - y));

export const RulesInput = z
  .object({
    timezone: z.string().refine((tz) => US_TIMEZONES.some((t) => t.value === tz), "Pick a US time zone."),
    dailyTarget: z.number().int().min(1).max(2000),
    maxAttempts: z.number().int().min(1).max(20),
    spacingDays: z.number().int().min(0).max(30),
    workDays: weekdayList.refine((a) => a.length > 0, "Pick at least one work day."),
    freshDays: weekdayList,
    freshFloor: z.number().int().min(0).max(2000),
    callStartMinute: z.number().int().min(EARLIEST_MINUTE).max(LATEST_MINUTE),
    callEndMinute: z.number().int().min(EARLIEST_MINUTE).max(LATEST_MINUTE),
    maxCallsPer24h: z.number().int().min(1).max(10),
    doubleDial: z.boolean(),
    rebookAttempts: z.number().int().min(1).max(10),
    recycleDays: z.number().int().min(0).max(365),
    confirm48h: z.boolean(),
    confirm24h: z.boolean(),
    confirmDayOf: z.boolean(),
    ringSeconds: z.number().int().min(10).max(60),
    skipVoicemail: z.boolean(),
    autoDialConsentOnly: z.boolean(),
  })
  .refine((r) => r.callEndMinute > r.callStartMinute, {
    message: "Calling hours must end after they start.",
    path: ["callEndMinute"],
  });

/** Normalize a DB row (or nothing) into a full config. */
export function rulesFromRow(row: Partial<CallRulesConfig> | null | undefined): CallRulesConfig {
  if (!row) return { ...DEFAULT_RULES, workDays: [...DEFAULT_RULES.workDays], freshDays: [...DEFAULT_RULES.freshDays] };
  const out = { ...DEFAULT_RULES } as CallRulesConfig;
  for (const k of Object.keys(DEFAULT_RULES) as (keyof CallRulesConfig)[]) {
    const v = row[k];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  out.workDays = (out.workDays || []).filter((d) => d >= 1 && d <= 6);
  out.freshDays = (out.freshDays || []).filter((d) => d >= 1 && d <= 6);
  return out;
}

export type HoursCheck = { ok: true } | { ok: false; reason: string };

/** May we place a call to this clinic's leads right now? */
export function checkCallingHours(now: Date, rules: CallRulesConfig): HoursCheck {
  const day = dayInTz(now, rules.timezone);
  if (dow(day) === 0) return { ok: false, reason: "No calls on Sundays." };
  if (!isWorkDay(day, rules.workDays)) {
    return { ok: false, reason: "Today isn't one of this clinic's calling days." };
  }
  const m = minutesInTz(now, rules.timezone);
  const start = Math.max(rules.callStartMinute, EARLIEST_MINUTE);
  const end = Math.min(rules.callEndMinute, LATEST_MINUTE);
  if (m < start || m >= end) {
    return {
      ok: false,
      reason: `Outside calling hours. Calls are allowed ${minuteLabel(start)} to ${minuteLabel(end)} clinic time.`,
    };
  }
  return { ok: true };
}

export function hoursLabel(rules: CallRulesConfig): string {
  return `${minuteLabel(rules.callStartMinute)} to ${minuteLabel(rules.callEndMinute)}`;
}
