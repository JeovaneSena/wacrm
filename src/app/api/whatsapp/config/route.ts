import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  initInstance,
  getInstanceStatus,
  setInstanceWebhook,
  deleteInstance,
} from '@/lib/whatsapp/uazapi-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile.
 */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Base URL this CRM is reachable at, for registering the uazapi
 * inbound webhook. `NEXT_PUBLIC_SITE_URL` wins when set (required for
 * bare/non-proxied deploys); otherwise falls back to the proxy
 * headers every reverse proxy sets (Vercel, Hostinger, Cloudflare).
 */
function resolveWebhookBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) return `${new URL(request.url).protocol}//${host}`

  throw new Error(
    'Could not resolve this app’s public URL. Set NEXT_PUBLIC_SITE_URL.'
  )
}

/**
 * GET /api/whatsapp/config
 *
 * Response shape:
 *   { connected: true,  instance: {...} }
 *   { connected: false, reason: 'no_config' | 'token_corrupted' | 'uazapi_error' | ..., message: '...' }
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
      return NextResponse.json(
        { connected: false, reason: 'no_account', message: 'Your profile is not linked to an account.' },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id, server_url, instance_token, instance_id, instance_name, status, owner_phone')
      .eq('user_id', user.id)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config || !config.instance_token) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp instance connected yet.',
        },
        { status: 200 }
      )
    }

    let instanceToken: string
    try {
      instanceToken = decrypt(config.instance_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored instance token cannot be decrypted with the current ENCRYPTION_KEY. Click "Reset Configuration" below, then reconnect.',
        },
        { status: 200 }
      )
    }

    try {
      const instance = await getInstanceStatus({ serverUrl: config.server_url, instanceToken })
      const connected = instance.status === 'connected'

      // Keep the local status mirror fresh — the connect/status routes
      // do this too, but a plain GET (e.g. page load) should also
      // self-heal a stale 'connecting' row.
      if (instance.status !== config.status || instance.owner !== config.owner_phone) {
        await supabaseAdmin()
          .from('whatsapp_config')
          .update({
            status: instance.status,
            owner_phone: instance.owner || null,
            connected_at: connected ? new Date().toISOString() : null,
          })
          .eq('id', config.id)
      }

      return NextResponse.json({
        connected,
        instance: {
          status: instance.status,
          owner: instance.owner,
          profileName: instance.profileName,
          name: instance.name,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown uazapi API error'
      console.error('[whatsapp/config GET] uazapi status check failed:', message)
      return NextResponse.json(
        { connected: false, reason: 'uazapi_error', message: `uazapi server error: ${message}` },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Two ways to connect:
 *   - `{ server_url, admin_token, instance_name }` — creates a brand
 *     new instance on the caller's uazapiGO server.
 *   - `{ server_url, instance_token }` — adopts an instance token the
 *     user already has (e.g. created via the uazapi panel directly).
 *
 * Either way: validates against the uazapi server, registers our
 * webhook on the instance, encrypts + stores the instance token.
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
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { server_url, admin_token, instance_name, instance_token: providedToken } = body

    if (!server_url || typeof server_url !== 'string') {
      return NextResponse.json({ error: 'server_url is required' }, { status: 400 })
    }
    const serverUrl = server_url.replace(/\/+$/, '')

    if (!admin_token && !providedToken) {
      return NextResponse.json(
        { error: 'Provide either admin_token (to create a new instance) or instance_token (to adopt an existing one).' },
        { status: 400 }
      )
    }

    let instanceToken: string
    let instanceId: string | null = null
    let resolvedName = instance_name || 'wacrm'
    // Adopting an already-paired instance must not force a QR re-scan:
    // keep the live status so the frontend can skip pairing entirely.
    let instanceStatus = 'disconnected'
    let instanceOwner: string | null = null
    let instanceProfileName: string | null = null

    try {
      if (providedToken) {
        instanceToken = providedToken
        const instance = await getInstanceStatus({ serverUrl, instanceToken })
        instanceId = instance.id
        resolvedName = instance.name || resolvedName
        instanceStatus = instance.status || 'disconnected'
        instanceOwner = instance.owner || null
        instanceProfileName = instance.profileName || null
      } else {
        const instance = await initInstance({
          serverUrl,
          adminToken: admin_token,
          name: resolvedName,
        })
        instanceToken = instance.token
        instanceId = instance.id
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown uazapi API error'
      console.error('uazapi instance setup failed:', message)
      return NextResponse.json({ error: `uazapi server error: ${message}` }, { status: 400 })
    }

    // Register our webhook on the instance so inbound messages reach us.
    let webhookUrl: string
    try {
      webhookUrl = `${resolveWebhookBaseUrl(request)}/api/whatsapp/webhook`
      await setInstanceWebhook({ serverUrl, instanceToken, url: webhookUrl })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.warn('uazapi webhook registration failed (non-fatal):', message)
    }

    let encryptedInstanceToken: string
    try {
      encryptedInstanceToken = encrypt(instanceToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()

    const connected = instanceStatus === 'connected'
    const baseRow = {
      provider: 'uazapi',
      server_url: serverUrl,
      instance_token: encryptedInstanceToken,
      instance_id: instanceId,
      instance_name: resolvedName,
      status: instanceStatus,
      owner_phone: instanceOwner,
      connected_at: connected ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('id', existing.id)
      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })
      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      saved: true,
      status: instanceStatus,
      owner: instanceOwner,
      profileName: instanceProfileName,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Disconnects the instance server-side (best-effort) and removes the
 * account's config row.
 */
export async function DELETE() {
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
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('id, server_url, instance_token')
      .eq('user_id', user.id)
      .maybeSingle()

    if (config?.instance_token) {
      try {
        const instanceToken = decrypt(config.instance_token)
        await deleteInstance({ serverUrl: config.server_url, instanceToken })
      } catch (err) {
        console.warn('Best-effort uazapi instance deletion failed:', err)
      }
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
