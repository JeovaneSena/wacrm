import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { connectInstance, getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
import { decrypt } from '@/lib/whatsapp/encryption'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * POST /api/whatsapp/connect
 *
 * Starts (or restarts) pairing for the account's uazapi instance.
 * Body `{ phone? }` — omit for a QR code, pass an E.164 phone for a
 * pairing code instead. Returns the QR/pair code for the Settings UI
 * to render; the UI then polls GET /api/whatsapp/status until
 * `connected`.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id, server_url, instance_token')
      .eq('user_id', user.id)
      .maybeSingle()

    if (configError || !config || !config.instance_token) {
      return NextResponse.json(
        { error: 'No WhatsApp instance set up yet. Save the server details first.' },
        { status: 400 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const phone = typeof body?.phone === 'string' && body.phone ? body.phone : undefined

    const instanceToken = decrypt(config.instance_token)

    // Guard: never (re)start pairing for an instance that's already
    // connected — uazapi's /instance/connect can drop a live session.
    // A stray "refresh QR" click must be a no-op in that state.
    const current = await getInstanceStatus({ serverUrl: config.server_url, instanceToken })
    if (current.status === 'connected') {
      await supabase
        .from('whatsapp_config')
        .update({
          status: 'connected',
          owner_phone: current.owner || null,
          connected_at: new Date().toISOString(),
        })
        .eq('id', config.id)
      return NextResponse.json({ status: 'connected', qrcode: null, paircode: null })
    }

    const instance = await connectInstance({ serverUrl: config.server_url, instanceToken, phone })

    await supabase
      .from('whatsapp_config')
      .update({ status: instance.status })
      .eq('id', config.id)

    return NextResponse.json({
      status: instance.status,
      qrcode: instance.qrcode || null,
      paircode: instance.paircode || null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error in WhatsApp connect POST:', message)
    return NextResponse.json({ error: `uazapi server error: ${message}` }, { status: 500 })
  }
}
