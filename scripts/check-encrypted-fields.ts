/**
 * Report which encrypted values the currently-configured keys can still read.
 *
 *   DATABASE_URL=... FIELD_ENCRYPTION_KEY=... npx tsx scripts/check-encrypted-fields.ts
 *
 * Scans every text column for values written by `encryptField` (the "enc:v1:"
 * marker) and tries to decrypt each one. Anything listed as UNREADABLE was
 * encrypted under a key that is no longer configured — add that key to
 * FIELD_ENCRYPTION_KEY_PREVIOUS to recover it.
 *
 * Run this before and after any FIELD_ENCRYPTION_KEY rotation. Read-only.
 */
import { PrismaClient } from "@prisma/client";
import { decryptField, isDecryptFailure } from "../src/lib/encryption";

const prisma = new PrismaClient();
const MARKER = "enc:v1:";

async function main() {
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error("FIELD_ENCRYPTION_KEY is not set — nothing could be decrypted.");
    process.exit(1);
  }

  const cols = (await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text','character varying')
    ORDER BY table_name, column_name`)) as Array<{
    table_name: string;
    column_name: string;
  }>;

  let totalEncrypted = 0;
  let totalUnreadable = 0;
  const affected: string[] = [];

  for (const { table_name: t, column_name: c } of cols) {
    let rows: Array<{ v: string }>;
    try {
      rows = (await prisma.$queryRawUnsafe(
        `SELECT "${c}" AS v FROM "${t}" WHERE "${c}" LIKE '${MARKER}%'`,
      )) as Array<{ v: string }>;
    } catch {
      continue; // view, permission issue, or otherwise not scannable
    }
    if (!rows.length) continue;

    const bad = rows.filter((r) => isDecryptFailure(decryptField(r.v))).length;
    totalEncrypted += rows.length;
    totalUnreadable += bad;
    const line = `  ${`${t}.${c}`.padEnd(38)} encrypted=${String(rows.length).padStart(5)}  unreadable=${String(bad).padStart(5)}`;
    console.log(bad ? `${line}   <-- UNREADABLE` : line);
    if (bad) affected.push(`${t}.${c} (${bad})`);
  }

  console.log(
    `\n${totalEncrypted} encrypted value(s); ${totalUnreadable} unreadable with the configured key(s).`,
  );
  if (totalUnreadable) {
    console.log(`Affected: ${affected.join(", ")}`);
    console.log(
      "These were encrypted under a key that is no longer configured. Add it to\n" +
        "FIELD_ENCRYPTION_KEY_PREVIOUS (comma-separated) to make them readable again.",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
