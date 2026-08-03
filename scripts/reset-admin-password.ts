/**
 * Reset a RevOS login password from the command line.
 *
 *   DATABASE_URL=... npx tsx scripts/reset-admin-password.ts <email>
 *
 * The password is read from a hidden prompt — never an argument or an env var —
 * so it stays out of shell history, `ps` output, and CI logs. Use this when an
 * admin is locked out; the seed script deliberately won't touch an existing
 * user's password.
 *
 * Also clears any half-finished MFA enrollment (`mfaPendingSecret`), which is
 * inert but confusing to find later. A *live* factor is left alone: use the
 * --clear-mfa flag to also turn off an enabled authenticator.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import readline from "readline";

const prisma = new PrismaClient();

/** Prompt without echoing keystrokes. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    // @ts-expect-error — swapping the write hook is the standard trick for this.
    rl._writeToOutput = (s: string) => {
      if (!out.muted) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      out.muted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
    out.muted = true;
  });
}

async function main() {
  const clearMfa = process.argv.includes("--clear-mfa");
  const email = (
    process.argv.slice(2).find((a) => !a.startsWith("--")) ||
    process.env.SUPER_ADMIN_EMAIL ||
    ""
  )
    .toLowerCase()
    .trim();

  if (!email) {
    console.error("Usage: npx tsx scripts/reset-admin-password.ts <email> [--clear-mfa]");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with email ${email}.`);
    const all = await prisma.user.findMany({
      where: { role: "SUPER_ADMIN" },
      select: { email: true },
    });
    if (all.length) {
      console.error(`Super admins on this database: ${all.map((u) => u.email).join(", ")}`);
    }
    process.exit(1);
  }

  console.log(
    `Resetting: ${user.email} (${user.role}, ${user.isActive ? "active" : "INACTIVE"}, ` +
      `MFA ${user.mfaEnabled ? "enabled" : "off"})`,
  );

  const pw = await askHidden("New password: ");
  const confirm = await askHidden("Confirm password: ");
  if (pw.length < 12) {
    console.error("Password must be at least 12 characters.");
    process.exit(1);
  }
  if (pw !== confirm) {
    console.error("Passwords didn't match.");
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(pw, 10),
      // A stale pending enrollment is never a live factor — always safe to drop.
      mfaPendingSecret: null,
      ...(clearMfa ? { mfaEnabled: false, mfaSecret: null } : {}),
    },
  });

  console.log(`Password updated for ${user.email}.`);
  if (user.mfaEnabled && !clearMfa) {
    console.log("MFA is still enabled — you'll need your authenticator code to sign in.");
  }
  if (clearMfa && user.mfaEnabled) {
    console.log("MFA disabled. Re-enroll from Admin → Security.");
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
