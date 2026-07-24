"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { hasMinRole, type AccountRole } from "@/lib/auth/roles";

/**
 * Hard page-level gate — redirects to /inbox if the caller's role is
 * below `min`. The sidebar already hides these routes from Agente,
 * but hiding a nav item doesn't stop someone from typing the URL
 * directly; this is the actual enforcement. Waits for the profile to
 * finish loading before deciding, so a fresh page load doesn't bounce
 * an admin+ user during the brief window `accountRole` is still null.
 */
export function useRequireMinRole(min: AccountRole): void {
  const router = useRouter();
  const { accountRole, profileLoading } = useAuth();

  useEffect(() => {
    if (profileLoading) return;
    if (!accountRole || !hasMinRole(accountRole, min)) {
      router.replace("/inbox");
    }
  }, [accountRole, profileLoading, min, router]);
}
