"use client";

import { signOut } from "next-auth/react";
import { Icon } from "./icon";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="nav-link w-full"
    >
      <Icon name="logout" className="h-[18px] w-[18px] text-ink-subtle" />
      <span>Sign out</span>
    </button>
  );
}
