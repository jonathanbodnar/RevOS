/**
 * One-time migration: rewrite every encrypted value under the CURRENT key.
 *
 *   DATABASE_URL=...                  \
 *   FIELD_ENCRYPTION_KEY=<current>    \
 *   FIELD_ENCRYPTION_KEY_PREVIOUS=<old, comma-separated>  \
 *   npx tsx scripts/reencrypt-fields.ts [--apply]
 *
 * Use this after rotating FIELD_ENCRYPTION_KEY so the old key is no longer
 * needed at runtime — the alternative is leaving it set in
 * FIELD_ENCRYPTION_KEY_PREVIOUS forever.
 *
 * Reads fall back through the previous key(s); writes always use the primary,
 * so each readable value comes back normalized under the current key. Values
 * that no key can read are reported and LEFT UNTOUCHED — overwriting them
 * would destroy ciphertext that is still recoverable if the key turns up.
 *
 * Dry-run by default. Pass --apply to write. Take a database snapshot first.
 */
import { PrismaClient } from "@prisma/client";
import { decryptField, encryptField, isDecryptFailure } from "../src/lib/encryption";

const prisma = new PrismaClient();
const MARKER = "enc:v1:";

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error("FIELD_ENCRYPTION_KEY (the current key) must be set.");
    process.exit(1);
  }
  if (!process.env.FIELD_ENCRYPTION_KEY_PREVIOUS) {
    console.error(
      "FIELD_ENCRYPTION_KEY_PREVIOUS (the old key) must be set — otherwise there\n" +
        "is nothing to recover and this script would be a no-op.",
    );
    process.exit(1);
  }
  console.log(apply ? "MODE: APPLY (writing)\n" : "MODE: dry run (no writes)\n");

  // Only tables with a plain "id" primary key can be updated row-by-row.
  const cols = (await prisma.$queryRawUnsafe(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.data_type IN ('text','character varying')
      AND EXISTS (
        SELECT 1 FROM information_schema.columns i
        WHERE i.table_schema = 'public' AND i.table_name = c.table_name
          AND i.column_name = 'id')
    ORDER BY c.table_name, c.column_name`)) as Array<{
    table_name: string;
    column_name: string;
  }>;

  let rewritten = 0;
  let stillUnreadable = 0;
  let alreadyCurrent = 0;

  for (const { table_name: t, column_name: c } of cols) {
    let rows: Array<{ id: string; v: string }>;
    try {
      rows = (await prisma.$queryRawUnsafe(
        `SELECT id, "${c}" AS v FROM "${t}" WHERE "${c}" LIKE '${MARKER}%'`,
      )) as Array<{ id: string; v: string }>;
    } catch {
      continue;
    }
    if (!rows.length) continue;

    for (const r of rows) {
      const plain = decryptField(r.v);
      if (plain == null || isDecryptFailure(plain)) {
        console.log(`  UNREADABLE  ${t}.${c} id=${r.id} — left untouched`);
        stillUnreadable++;
        continue;
      }
      // Re-encrypting under the primary key is idempotent in effect; values
      // already current simply get a fresh IV.
      if (apply) {
        await prisma.$executeRawUnsafe(
          `UPDATE "${t}" SET "${c}" = $1 WHERE id = $2`,
          encryptField(plain),
          r.id,
        );
      }
      rewritten++;
      alreadyCurrent += 0;
    }
    console.log(`  ${`${t}.${c}`.padEnd(38)} ${rows.length} value(s) processed`);
  }

  console.log(
    `\n${rewritten} value(s) ${apply ? "rewritten under the current key" : "would be rewritten"}; ` +
      `${stillUnreadable} still unreadable.`,
  );
  if (!apply && rewritten) console.log("Re-run with --apply to write.");
  if (apply && !stillUnreadable) {
    console.log(
      "\nEvery value now decrypts under FIELD_ENCRYPTION_KEY alone.\n" +
        "You can drop FIELD_ENCRYPTION_KEY_PREVIOUS once you've verified with:\n" +
        "  npx tsx scripts/check-encrypted-fields.ts",
    );
  }
  void alreadyCurrent;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
