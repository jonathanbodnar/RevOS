import { z } from "zod";

// A permissive-but-sane email check. Zod's bundled `.email()` check has
// historically been finicky; we use our own regex so the exact validation
// rules are explicit and stable.
const EMAIL_RE =
  /^[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

export const email = () =>
  z.string().trim().refine((s) => EMAIL_RE.test(s), {
    message: "Invalid email",
  });

export const optionalEmail = () =>
  z
    .string()
    .trim()
    .optional()
    .refine(
      (s) => !s || EMAIL_RE.test(s),
      { message: "Invalid email" },
    );
