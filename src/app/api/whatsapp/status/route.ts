import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api'
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
 * GET /api/whatsapp/status
 *
 * Lightweight poll target for the Settings QR modal — returns the
 * live pairing state (and a fresh QR while still 'connecting') so the
 * UI can flip from "scan me" to "connected" without a page reload.
 */
export async function GET() {
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
      .select('server_url, instance_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config || !config.instance_token) {
      return NextResponse.json({ status: 'disconnected', configured: false })
    }

    const instanceToken = decrypt(config.instance_token)
    const instance = await getInstanceStatus({ serverUrl: config.server_url, instanceToken })
    const connected = instance.status === 'connected'

    await supabase
      .from('whatsapp_config')
      .update({
        status: instance.status,
        owner_phone: instance.owner || null,
        connected_at: connected ? new Date().toISOString() : null,
      })
      .eq('account_id', accountId)

    return NextResponse.json({
      configured: true,
      status: instance.status,
      qrcode: instance.qrcode || null,
      paircode: instance.paircode || null,
      owner: instance.owner || null,
      profileName: instance.profileName || null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error in WhatsApp status GET:', message)
    return NextResponse.json({ error: `uazapi server error: ${message}` }, { status: 500 })
  }
}
