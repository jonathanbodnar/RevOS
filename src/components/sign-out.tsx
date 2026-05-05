"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="btn-secondary w-full justify-center"
    >
      Sign out
    </button>
  );
}
