// ============================================================
// POST /api/auth/signup — invite-only account creation.
//
// Public GoTrue signup is expected to be DISABLED in the Supabase
// dashboard (Authentication → Sign In / Up → "Allow new users to
// sign up" off); this route is then the only door in. It verifies a
// pending, unexpired invitation first and creates the user through
// the ADMIN API (which bypasses the public-signup switch), with the
// email pre-confirmed so the client can sign in immediately and
// proceed to /join/<token> to redeem.
//
// The invite is NOT consumed here — redemption stays in the existing
// /api/invitations/[token]/redeem flow, which moves the new user into
// the inviting account and deletes the auto-created personal one.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

import { hashInviteToken } from '@/lib/auth/invitations'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}

export async function POST(request: Request) {
  const ip = getClientIp(request)
  // Reuse the invitation-peek budget — signup attempts are rarer than
  // peeks, so sharing the stricter limit is fine.
  const limit = checkRateLimit(`signup:${ip}`, RATE_LIMITS.invitationPeek)
  if (!limit.success) return rateLimitResponse(limit)

  let body: { token?: string; email?: string; password?: string; full_name?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { token, email, password, full_name } = body
  if (!token || !email || !password) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }
  if (password.length < 6) {
    return NextResponse.json({ error: 'password_too_short' }, { status: 400 })
  }

  // Validate the invitation BEFORE creating anything.
  const { data: peek, error: peekErr } = await supabaseAdmin().rpc('peek_invitation', {
    p_token_hash: hashInviteToken(token),
  })
  if (peekErr) {
    console.error('[signup] peek rpc error:', peekErr)
    return NextResponse.json({ error: 'server_error' }, { status: 500 })
  }
  if (!peek?.ok) {
    return NextResponse.json(
      { error: 'invalid_invite', reason: peek?.reason ?? 'not_found' },
      { status: 403 },
    )
  }

  const { data: created, error: createErr } = await supabaseAdmin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name || '' },
  })

  if (createErr) {
    // Most common: email already registered. Surface a stable code the
    // page can translate.
    const alreadyExists = /already.*(registered|exists)/i.test(createErr.message)
    return NextResponse.json(
      { error: alreadyExists ? 'email_taken' : 'create_failed', message: createErr.message },
      { status: alreadyExists ? 409 : 500 },
    )
  }

  // 'new_account' invites only authorize signup — the personal account
  // the handle_new_user trigger just created IS the final workspace, so
  // consume the invite here (member invites are consumed at redeem).
  if (peek.kind === 'new_account') {
    const { error: consumeErr } = await supabaseAdmin()
      .from('account_invitations')
      .update({ accepted_at: new Date().toISOString(), accepted_by_user_id: created.user?.id ?? null })
      .eq('token_hash', hashInviteToken(token))
      .is('accepted_at', null)
    if (consumeErr) {
      console.error('[signup] failed to consume new_account invite:', consumeErr.message)
    }
  }

  return NextResponse.json({ success: true, user_id: created.user?.id, kind: peek.kind ?? 'member' })
}
