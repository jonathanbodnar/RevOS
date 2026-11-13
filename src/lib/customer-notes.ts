/**
 * Customer notes — the dated feed on a customer profile's Notes tab.
 *
 * Shared by the profile page (the initial feed) and the notes API (the entry
 * it hands back after a write) so a note renders the same either way.
 */
import { prisma } from "./prisma";
import { decryptField, isDecryptFailure } from "./encryption";

/** Longest note accepted, in characters (matches chart progress notes). */
export const NOTE_MAX_LENGTH = 5000;

/** A note as the feed renders it. */
export type NoteView = {
  id: string;
  /** Plaintext, or null when the stored ciphertext can't be decrypted. */
  body: string | null;
  authorName: string;
  createdAt: string; // ISO
  canRemove: boolean;
};

type Viewer = { id: string; originalRole: string };

/** A note may be removed by the person who wrote it, or by a super admin. */
export function canRemoveNote(
  note: { authorId: string },
  viewer: Viewer,
): boolean {
  return note.authorId === viewer.id || viewer.originalRole === "SUPER_ADMIN";
}

/** Decrypt stored notes, resolve their bylines, and flag which `viewer` may remove. */
export async function toNoteViews(
  notes: { id: string; body: string; authorId: string; createdAt: Date }[],
  viewer: Viewer,
): Promise<NoteView[]> {
  const authorIds = [...new Set(notes.map((n) => n.authorId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameById = new Map(authors.map((a) => [a.id, a.name?.trim() || a.email]));

  return notes.map((n) => {
    const body = decryptField(n.body);
    return {
      id: n.id,
      body: isDecryptFailure(body) ? null : body,
      authorName: nameById.get(n.authorId) ?? "Unknown user",
      createdAt: n.createdAt.toISOString(),
      canRemove: canRemoveNote(n, viewer),
    };
  });
}
