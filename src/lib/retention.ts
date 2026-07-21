/**
 * Data-retention purge.
 *
 * Each class is gated by its own env var and is a NO-OP when unset — retention
 * is opt-in so nothing is ever deleted by surprise. Set days per class:
 *   AUDIT_RETENTION_DAYS      audit-log rows older than this are purged.
 *                             HIPAA expects ≥6 years — default suggestion 2555.
 *   CHAT_LOG_RETENTION_DAYS   assistant chat logs older than this are purged.
 *   KPI_FLAG_RETENTION_DAYS   resolved/dismissed KPI flags older than this.
 */
import { prisma } from "./prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

function cutoff(envVar: string, now: Date): Date | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

export type RetentionSummary = {
  dryRun: boolean;
  auditLogsPurged: number;
  chatLogsPurged: number;
  kpiFlagsPurged: number;
};

export async function runRetention(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<RetentionSummary> {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? new Date();
  const s: RetentionSummary = {
    dryRun,
    auditLogsPurged: 0,
    chatLogsPurged: 0,
    kpiFlagsPurged: 0,
  };

  const auditCutoff = cutoff("AUDIT_RETENTION_DAYS", now);
  if (auditCutoff) {
    const where = { createdAt: { lt: auditCutoff } };
    s.auditLogsPurged = dryRun
      ? await prisma.auditLog.count({ where })
      : (await prisma.auditLog.deleteMany({ where })).count;
  }

  const chatCutoff = cutoff("CHAT_LOG_RETENTION_DAYS", now);
  if (chatCutoff) {
    const where = { createdAt: { lt: chatCutoff } };
    s.chatLogsPurged = dryRun
      ? await prisma.chatLog.count({ where })
      : (await prisma.chatLog.deleteMany({ where })).count;
  }

  const flagCutoff = cutoff("KPI_FLAG_RETENTION_DAYS", now);
  if (flagCutoff) {
    const where = {
      status: { in: ["resolved", "dismissed"] },
      updatedAt: { lt: flagCutoff },
    };
    s.kpiFlagsPurged = dryRun
      ? await prisma.kPIFlag.count({ where })
      : (await prisma.kPIFlag.deleteMany({ where })).count;
  }

  return s;
}
