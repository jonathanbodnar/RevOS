/**
 * Ad-hoc InBody connectivity probe (run manually, not part of the app).
 *
 *   npx tsx --env-file=.env scripts/inbody-probe.ts [YYYY-MM-DD]
 *
 * Or with inline credentials:
 *   INBODY_ACCOUNT=xxx INBODY_API_KEY=yyy npx tsx scripts/inbody-probe.ts
 *
 * It runs the same calls the admin tooling uses:
 *   1. POST /user/test               (credential check)
 *   2. GetTodayMeasurements { Date } (data-API access check)
 *   3. GetFullInBodyData / GetInBodyData for the first record found
 */
import {
  inbodyAccount,
  inbodyConfigured,
  inbodyConnectionTest,
  inbodyGetTodayMeasurements,
  fetchInBodyResults,
} from "../src/lib/inbody";

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate(),
  ).padStart(2, "0")}`;
}

async function main() {
  const date = process.argv[2] || today();
  console.log("InBody probe");
  console.log("  account:   ", inbodyAccount() || "(none)");
  console.log("  configured:", inbodyConfigured());
  console.log("  date:      ", date);
  console.log("");

  if (!inbodyConfigured()) {
    console.error(
      "✗ INBODY_API_KEY and INBODY_ACCOUNT are not set. Provide them via .env " +
        "(npx tsx --env-file=.env ...) or inline env vars, then re-run.",
    );
    process.exit(1);
  }

  console.log("1) POST /user/test …");
  const conn = await inbodyConnectionTest();
  console.log(`   → ok=${conn.ok} status=${conn.status}`);
  console.log(`   → body: ${conn.body.slice(0, 300)}`);
  console.log("");

  console.log(`2) GetTodayMeasurements { Date: ${date} } …`);
  const measurements = await inbodyGetTodayMeasurements(date);
  if (measurements.error) {
    console.log(`   → error: ${measurements.error}`);
  } else {
    console.log(`   → ${measurements.records.length} record(s)`);
    for (const r of measurements.records.slice(0, 10)) {
      console.log(
        `     UserID=${r.UserID || "-"} UserToken=${r.UserToken || "-"} DateTimes=${r.DateTimes}`,
      );
    }
  }
  console.log("");

  const first = measurements.records[0];
  if (first) {
    console.log("3) Fetch full result for first record …");
    const res = await fetchInBodyResults({
      phone: first.UserToken || null,
      userId: first.UserToken ? null : first.UserID,
      datetimes: first.DateTimes,
    });
    if (res.error) console.log(`   → error: ${res.error}`);
    else console.log("   → metrics:", JSON.stringify(res.metrics, null, 2));
  } else {
    console.log("3) Skipped full-data fetch (no records for that date).");
  }
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
