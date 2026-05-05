import { prisma } from "./prisma";

export async function logAudit(input: {
  actorId?: string | null;
  actorRole?: string | null;
  clinicId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        clinicId: input.clinicId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });
  } catch (e) {
    console.error("[audit] failed to log", input.action, e);
  }
}
