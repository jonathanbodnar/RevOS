import { prisma } from "@/lib/prisma";

/**
 * Resolve an implementor by name (case-insensitive), creating one if it doesn't
 * exist yet. Used by the `?implementor=<name>` payment-link tag so attribution
 * works even before the implementor has been set up in the admin.
 *
 * Returns the implementor id, or null for empty/invalid input.
 */
export async function resolveOrCreateImplementorByName(
  rawName: string | null | undefined,
): Promise<string | null> {
  const name = (rawName ?? "").trim();
  if (!name || name.length > 120) return null;

  const existing = await prisma.implementor.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.implementor.create({
    data: { name },
    select: { id: true },
  });
  return created.id;
}
