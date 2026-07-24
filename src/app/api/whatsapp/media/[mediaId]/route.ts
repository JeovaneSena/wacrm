import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { downloadMedia } from '@/lib/whatsapp/uazapi-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveConfigForConversation } from '@/lib/whatsapp/resolve-config'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Resolve the specific number this media belongs to via the
    // message row (migration 048) — RLS on `messages` already scopes
    // this to conversations the caller can see, so a 404 here also
    // means "not yours to fetch," not just "doesn't exist."
    const { data: message } = await supabase
      .from('messages')
      .select('conversation:conversations(whatsapp_config_id)')
      .eq('message_id', mediaId)
      .maybeSingle()
    const conv = Array.isArray(message?.conversation)
      ? message?.conversation[0]
      : message?.conversation
    const whatsappConfigId = (conv?.whatsapp_config_id as string | null | undefined) ?? null

    const config = await resolveConfigForConversation<{
      server_url: string
      instance_token: string
    }>(supabase, accountId, whatsappConfigId, 'server_url, instance_token')

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    if (!config.instance_token) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }
    const instanceToken = decrypt(config.instance_token)

    const { buffer, contentType } = await downloadMedia({
      serverUrl: config.server_url,
      instanceToken,
      messageId: mediaId,
    })

    const bytes = new Uint8Array(buffer)
    const total = bytes.length

    // Video/audio seeking needs byte-range support — without it the
    // browser can't jump to an arbitrary timestamp, since it has no
    // way to fetch just that slice. `downloadMedia` already pulls the
    // whole file from uazapi, so this just slices what's in memory
    // rather than re-requesting upstream per range.
    const range = request.headers.get('range')
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match?.[1] ? parseInt(match[1], 10) : 0
      const end = match?.[2] ? parseInt(match[2], 10) : total - 1
      const clampedEnd = Math.min(end, total - 1)

      if (start >= total || start > clampedEnd) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        })
      }

      const slice = bytes.slice(start, clampedEnd + 1)
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': contentType || 'application/octet-stream',
          'Content-Range': `bytes ${start}-${clampedEnd}/${total}`,
          'Content-Length': String(slice.length),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
