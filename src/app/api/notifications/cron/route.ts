import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// How long a customer can wait with no assigned agent before the whole
// team gets pinged. Deliberately a constant (like the dashboard's SLA
// target) — not worth a settings surface yet.
const UNATTENDED_MINUTES = 10

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * Scan for conversations where the customer is waiting with no
 * assigned agent past the threshold, and notify every agent+ member of
 * the account (one notification per member per waiting episode).
 *
 * Meant to run on a schedule (Vercel Cron / external pinger). Auth:
 * either `x-cron-secret: <AUTOMATION_CRON_SECRET>` (external pingers,
 * same secret the automations cron uses) or Vercel Cron's automatic
 * `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: Request) {
  const sharedSecret = process.env.AUTOMATION_CRON_SECRET
  const vercelSecret = process.env.CRON_SECRET
  if (!sharedSecret && !vercelSecret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  const bearer = request.headers.get('authorization')
  const authorized =
    (sharedSecret && supplied === sharedSecret) ||
    (vercelSecret && bearer === `Bearer ${vercelSecret}`)
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const cutoff = new Date(Date.now() - UNATTENDED_MINUTES * 60_000).toISOString()

  // Candidates: unassigned, open/pending, last activity from before the
  // cutoff. The per-conversation check below confirms the last message
  // really is the customer's (an "open" thread may already be answered).
  const { data: candidates, error } = await admin
    .from('conversations')
    .select('id, account_id, contact_id, last_message_at, messages(sender_type, created_at)')
    .is('assigned_agent_id', null)
    .in('status', ['open', 'pending'])
    .lte('last_message_at', cutoff)
    .order('created_at', { foreignTable: 'messages', ascending: false })
    .limit(1, { foreignTable: 'messages' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let notified = 0
  for (const conv of candidates ?? []) {
    const last = (conv.messages as { sender_type: string; created_at: string }[] | null)?.[0]
    if (!last || last.sender_type !== 'customer') continue

    // One alert per waiting episode: skip if a notification for this
    // conversation was already created after the customer's message.
    const { data: already } = await admin
      .from('notifications')
      .select('id')
      .eq('conversation_id', conv.id)
      .eq('type', 'unattended_conversation')
      .gte('created_at', last.created_at)
      .limit(1)
      .maybeSingle()
    if (already) continue

    const { data: members } = await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', conv.account_id)
      .in('account_role', ['agent', 'admin', 'owner'])
    if (!members || members.length === 0) continue

    const waitedMin = Math.round((Date.now() - new Date(last.created_at).getTime()) / 60_000)
    const rows = members.map((m: { user_id: string }) => ({
      account_id: conv.account_id,
      user_id: m.user_id,
      type: 'unattended_conversation',
      conversation_id: conv.id,
      contact_id: conv.contact_id,
      title: 'Conversation waiting with no agent',
      body: `Aguardando resposta há ${waitedMin} min sem atendente atribuído.`,
    }))
    const { error: insErr } = await admin.from('notifications').insert(rows)
    if (insErr) {
      console.error('[notifications cron] insert failed:', insErr.message)
      continue
    }
    notified += 1
  }

  return NextResponse.json({ scanned: candidates?.length ?? 0, notified })
}
