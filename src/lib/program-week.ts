/**
 * Program-week math, shared by the customer-profile chart and the reporting
 * KPIs so both number weeks identically.
 *
 * Week 1 begins on the program anchor date (the customer's signed date, or
 * their first paid charge when unset) and runs 7 days. These numbers are the
 * same "week N" used to label InBody scans, so a scan on program day 15 is a
 * week-3 scan in both the chart and reporting.
 */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Hard ceiling on rendered week rows (~2 years) so a very old anchor can't
// balloon the grid to hundreds of rows.
export const MAX_PROGRAM_WEEKS = 104;

/**
 * Normalize an anchor to UTC midnight of its calendar day. Week boundaries are
 * then day-aligned, so the date labels (floored to a UTC date) and the scan
 * buckets (half-open instant ranges) agree instead of drifting by the anchor's
 * time-of-day.
 */
export function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

/** 1-based program week that `at` falls in, given the program `anchor`. */
export function programWeekOf(anchor: Date, at: Date): number {
  const diff = at.getTime() - anchor.getTime();
  if (diff < 0) return 0; // before the program started
  return Math.floor(diff / WEEK_MS) + 1;
}

/** UTC-ish [start, end) bounds of a given 1-based program week. */
export function weekBounds(
  anchor: Date,
  weekNumber: number,
): { start: Date; end: Date } {
  const start = new Date(anchor.getTime() + (weekNumber - 1) * WEEK_MS);
  const end = new Date(start.getTime() + WEEK_MS);
  return { start, end };
}

/**
 * How many week rows to show for a customer: enough to cover the elapsed
 * program time and any week already charted, with a sensible minimum so a
 * brand-new patient still gets a usable grid.
 */
export function weeksToShow(
  anchor: Date | null,
  now: Date,
  chartedWeeks: number[],
  minWeeks = 6,
): number {
  const elapsed = anchor ? programWeekOf(anchor, now) : 0;
  const highestCharted = chartedWeeks.length ? Math.max(...chartedWeeks) : 0;
  return Math.min(
    MAX_PROGRAM_WEEKS,
    Math.max(minWeeks, elapsed, highestCharted),
  );
}
