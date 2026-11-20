/**
 * Clinic-local calendar helpers.
 *
 * The desk reasons in clinic-local calendar days ("YYYY-MM-DD") the way the
 * Dial Desk did: "try again in 2 work days", "48-hour call", "not on Sundays".
 * The server runs in UTC (Railway TZ=UTC), so every conversion goes through an
 * explicit IANA zone. Isomorphic: safe in client components.
 */

export type Day = string; // YYYY-MM-DD

const pad = (n: number) => String(n).padStart(2, "0");

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(date: Date, tz: string) {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** The clinic-local calendar day of an instant. */
export function dayInTz(date: Date, tz: string): Day {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes after local midnight. */
export function minutesInTz(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "YYYY-MM-DDTHH:mm" in the zone — the value a datetime-local input takes. */
export function localInputValue(date: Date | null | undefined, tz: string): string {
  if (!date) return "";
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Convert a clinic-local wall time ("YYYY-MM-DDTHH:mm") to the UTC instant.
 * Two passes settle DST edges; a time that doesn't exist (spring-forward gap)
 * lands an hour later, which is what a person would expect.
 */
export function zonedTimeToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || "");
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += want - seen;
  }
  return new Date(guess);
}

function dayToUtc(day: Day): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 0 = Sunday … 6 = Saturday. */
export function dow(day: Day): number {
  return new Date(dayToUtc(day)).getUTCDay();
}

export function addDays(day: Day, n: number): Day {
  const d = new Date(dayToUtc(day) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days from a to b (b − a). */
export function diffDays(a: Day, b: Day): number {
  return Math.round((dayToUtc(b) - dayToUtc(a)) / 86400000);
}

export function isWorkDay(day: Day, workDays: number[]): boolean {
  const w = dow(day);
  return w !== 0 && workDays.includes(w);
}

/** The n-th work day after `day` (Dial Desk addWorkDays; capped at 90 days). */
export function addWorkDays(day: Day, n: number, workDays: number[]): Day {
  let d = day;
  let k = 0;
  let guard = 0;
  while (k < n && guard++ < 90) {
    d = addDays(d, 1);
    if (isWorkDay(d, workDays)) k++;
  }
  return d;
}

export function nextWorkDay(day: Day, workDays: number[]): Day {
  return addWorkDays(day, 1, workDays);
}

/** Monday-first week containing `day`. */
export function weekDays(day: Day): Day[] {
  const back = (dow(day) + 6) % 7;
  const mon = addDays(day, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "9 AM", "7:30 PM" from minutes after midnight. */
export function minuteLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${pad(m)}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** "Tue, Oct 27 12:00 PM" in the clinic's zone. */
export function formatDateTime(date: Date | string | null | undefined, tz: string): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Fri, Oct 30" for a calendar day. */
export function formatDay(day: Day): string {
  const d = new Date(dayToUtc(day));
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Best-guess IANA zone for a US state (clinic address), for default rules. */
export function timezoneForState(state: string | null | undefined): string {
  const s = (state || "").trim().toUpperCase();
  const eastern = [
    "CT", "DE", "DC", "FL", "GA", "ME", "MD", "MA", "MI", "NH", "NJ", "NY", "NC",
    "OH", "PA", "RI", "SC", "VT", "VA", "WV", "IN", "KY",
    "CONNECTICUT", "DELAWARE", "FLORIDA", "GEORGIA", "MAINE", "MARYLAND", "MASSACHUSETTS",
    "MICHIGAN", "NEW HAMPSHIRE", "NEW JERSEY", "NEW YORK", "NORTH CAROLINA", "OHIO",
    "PENNSYLVANIA", "RHODE ISLAND", "SOUTH CAROLINA", "VERMONT", "VIRGINIA",
    "WEST VIRGINIA", "INDIANA", "KENTUCKY",
  ];
  const mountain = ["CO", "MT", "NM", "UT", "WY", "ID", "COLORADO", "MONTANA", "NEW MEXICO", "UTAH", "WYOMING", "IDAHO"];
  const pacific = ["CA", "OR", "WA", "NV", "CALIFORNIA", "OREGON", "WASHINGTON", "NEVADA"];
  if (eastern.includes(s)) return "America/New_York";
  if (mountain.includes(s)) return "America/Denver";
  if (pacific.includes(s)) return "America/Los_Angeles";
  if (s === "AZ" || s === "ARIZONA") return "America/Phoenix";
  if (s === "AK" || s === "ALASKA") return "America/Anchorage";
  if (s === "HI" || s === "HAWAII") return "Pacific/Honolulu";
  return "America/Chicago";
}

export const US_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];
