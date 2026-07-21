// ============================================================
// GET /api/account/invitations/[id]/reveal
//
// Admin+. Decrypts `token_encrypted` (migration 044) and returns the
// full invite URL again, for when the admin dismissed the one-time
// creation modal without copying it. Rows created before 044 have no
// `token_encrypted` and return 404 — revoke + recreate is the only
// recovery path for those.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { inviteUrl } from "@/lib/auth/invitations";
import { decrypt } from "@/lib/whatsapp/encryption";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { getBaseUrl } from "../../route";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:inviteReveal:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // No `eq('account_id', ...)` — RLS (`is_account_member(account_id,
    // 'admin')`) already scopes the SELECT to the caller's account,
    // same pattern as the revoke DELETE route.
    const { data, error } = await ctx.supabase
      .from("account_invitations")
      .select("token_encrypted, accepted_at, expires_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[GET /api/account/invitations/[id]/reveal] error:", error);
      return NextResponse.json({ error: "Failed to reveal invitation" }, { status: 500 });
    }
    if (!data || !data.token_encrypted) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }
    if (data.accepted_at) {
      return NextResponse.json({ error: "Invitation already used" }, { status: 409 });
    }
    if (new Date(data.expires_at) <= new Date()) {
      return NextResponse.json({ error: "Invitation has expired" }, { status: 409 });
    }

    let token: string;
    try {
      token = decrypt(data.token_encrypted);
    } catch (err) {
      console.error("[GET /api/account/invitations/[id]/reveal] decrypt failed:", err);
      return NextResponse.json({ error: "Failed to reveal invitation" }, { status: 500 });
    }

    return NextResponse.json({ url: inviteUrl(token, getBaseUrl(request)) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
