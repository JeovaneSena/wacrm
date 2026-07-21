import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getContactPhoto } from '@/lib/whatsapp/uazapi-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// `after()` runs within this route's max duration. Media proxying is
// lazy (the media route fetches on demand), so inbound processing here
// is cheap — this ceiling just gives headroom for automations/flows.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// ============================================================
// uazapi webhook payload shapes
//
// Confirmed 2026-07-10 against a live uazapiGO server (not just the
// vendor's Postman collection, which ships requests only — no
// response/webhook bodies). `quoted` (swipe-reply) and `reaction`
// events were NOT observed in that test session — both are parsed
// defensively below and degrade to "no context" / "skip" rather than
// throwing, but the exact field shape should be re-verified against
// real traffic once available.
// ============================================================

interface UazapiChat {
  wa_isGroup: boolean
  wa_contactName?: string
  name?: string
  wa_chatid: string
}

interface UazapiMessage {
  /** `"<instanceOwner>:<messageid>"` — globally unique, used as our message_id. */
  id: string
  /** The bare id suffix of `id`. */
  messageid: string
  chatid: string
  /** Baileys-raw type name, e.g. "Conversation", "ImageMessage", "ReactionMessage". */
  messageType: string
  /** Normalized coarse type: "text" | "media" | ... */
  type: string
  /** Non-empty for media: "image" | "video" | "audio" | "ptt" | "document" | "sticker". */
  mediaType: string
  /** Plain-text body, pre-extracted by uazapi regardless of messageType. */
  text: string
  isGroup: boolean
  fromMe: boolean
  messageTimestamp: number // milliseconds
  senderName: string
  /** Phone-number JID of the actual sender, e.g. "557381052765@s.whatsapp.net". Present even in groups. */
  sender_pn: string
  /**
   * Non-empty when the customer tapped a button or list row on a menu
   * we sent via /send/menu — carries the id we put on that choice.
   * Drives interactive_reply dispatch to Flows/Automations and the
   * messages.interactive_reply_id column.
   */
  buttonOrListid?: string
  /** Present (non-empty) on a reaction event — best-effort, unconfirmed shape. */
  reaction?: string
  /** Present (non-empty) on a swipe-reply — best-effort, unconfirmed shape. */
  quoted?: unknown
}

interface UazapiWebhookBody {
  EventType: 'messages' | 'messages_update' | 'connection' | string
  instanceName: string
  /** Plaintext instance token — matched against decrypted whatsapp_config.instance_token rows below. */
  token: string
  owner: string
  chat?: UazapiChat
  message?: UazapiMessage
  /** Only present on EventType === 'connection'. */
  instance?: { status: string; owner: string }
}

/**
 * Resolve the whatsapp_config row this webhook belongs to by matching
 * the plaintext `token` in the payload against each row's decrypted
 * instance_token. Same "decrypt and compare" pattern the old Meta
 * webhook used for verify_token — there's no per-request signature
 * header from uazapi, so the instance token IS the authentication.
 */
async function resolveConfigByToken(
  token: string
): Promise<{ id: string; account_id: string; user_id: string; server_url: string; instance_token: string } | null> {
  const { data: configs, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, user_id, server_url, instance_token')
    .not('instance_token', 'is', null)

  if (error || !configs) {
    console.error('[uazapi webhook] Error fetching configs:', error)
    return null
  }

  for (const config of configs) {
    try {
      if (decrypt(config.instance_token) === token) {
        if (isLegacyFormat(config.instance_token)) {
          void supabaseAdmin()
            .from('whatsapp_config')
            .update({ instance_token: encrypt(token) })
            .eq('id', config.id)
            .then(({ error: updErr }: { error: unknown }) => {
              if (updErr) console.warn('[uazapi webhook] instance_token GCM upgrade failed:', updErr)
            })
        }
        return config
      }
    } catch {
      // Malformed / wrong-key row — skip it and keep checking.
    }
  }
  return null
}

export async function POST(request: Request) {
  let body: UazapiWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 })
  }

  const config = await resolveConfigByToken(body.token)
  if (!config) {
    console.warn('[uazapi webhook] no whatsapp_config matched the payload token')
    return NextResponse.json({ error: 'Unknown instance' }, { status: 401 })
  }

  // Ack fast, process after — same reasoning as the old Meta webhook:
  // a slow ack triggers gateway retries / duplicate deliveries, and on
  // Vercel the function can be frozen the instant the response is
  // sent, so a detached (non-`after`) promise isn't guaranteed to
  // finish its DB writes.
  after(async () => {
    try {
      await processWebhook(body, config)
    } catch (error) {
      console.error('Error processing uazapi webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(
  body: UazapiWebhookBody,
  config: { account_id: string; user_id: string; server_url: string; instance_token: string }
) {
  if (body.EventType === 'connection' && body.instance) {
    const connected = body.instance.status === 'connected'
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        status: body.instance.status,
        owner_phone: body.instance.owner || null,
        connected_at: connected ? new Date().toISOString() : null,
      })
      .eq('account_id', config.account_id)
    return
  }

  if (body.EventType === 'messages_update') {
    // Status transitions (sent/delivered/read) and edited messages.
    // Not observed in the captured test session — best-effort no-op
    // until a real payload confirms the shape. Inbound messages and
    // outbound sends both still work without this; only read-receipt
    // ticks on the inbox would be missing.
    return
  }

  if (body.EventType !== 'messages' || !body.message) return

  const message = body.message

  // Groups (migration 042) get their own conversation — view + human
  // reply only. No bots (flows/automations/AI) ever run there; that
  // gate lives inside processGroupMessage, not here.
  if (message.isGroup) {
    await processGroupMessage(message, body.chat, config)
    return
  }

  // fromMe: we sent this — either via this CRM (send-message.ts already
  // persisted it synchronously) or directly from the paired phone /
  // WhatsApp Web. Mirror the latter so every outbound message shows up
  // in the CRM regardless of where it was typed; the former is deduped
  // by its uazapi message id inside processOutboundEcho.
  if (message.fromMe) {
    await processOutboundEcho(message, body.chat, config)
    return
  }

  await processMessage(message, body.chat, config)
}

/**
 * Find-or-create a group conversation by JID. Mirrors
 * findOrCreateConversation's race handling (unique index +
 * catch-and-refetch on 23505) — see migration 042.
 */
async function findOrCreateGroupConversation(
  accountId: string,
  configOwnerUserId: string,
  groupJid: string,
  subject: string | null,
  serverUrl: string,
  encryptedInstanceToken: string,
) {
  const { data: existing } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('group_jid', groupJid)
    .maybeSingle()

  if (existing) {
    const updates: Record<string, unknown> = {}
    // Keep the subject fresh (group name changes happen).
    if (subject && subject !== existing.group_subject) {
      updates.group_subject = subject
    }
    if (!existing.group_avatar_url) {
      const photo = await tryFetchContactPhoto(serverUrl, encryptedInstanceToken, groupJid)
      if (photo) updates.group_avatar_url = photo
    }
    if (Object.keys(updates).length > 0) {
      await supabaseAdmin().from('conversations').update(updates).eq('id', existing.id)
      Object.assign(existing, updates)
    }
    return { conversation: existing, created: false }
  }

  const groupAvatarUrl = await tryFetchContactPhoto(serverUrl, encryptedInstanceToken, groupJid)

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: null,
      chat_type: 'group',
      group_jid: groupJid,
      group_subject: subject,
      group_avatar_url: groupAvatarUrl,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('group_jid', groupJid)
        .maybeSingle()
      if (raced) return { conversation: raced, created: false }
    }
    console.error('[uazapi webhook] error creating group conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Inbound/outbound-echo handling for WhatsApp groups. Deliberately
 * thin compared to processMessage: no contact, no flows/automations/AI
 * dispatch, no first-message/interactive tracking — groups are a
 * human-only view+reply surface (see plan: "Grupos na Caixa de
 * Entrada"). Reactions/swipe-replies are skipped for the same reason
 * that kept processMessage lean before those were added — v1 scope.
 */
async function processGroupMessage(
  message: UazapiMessage,
  chat: UazapiChat | undefined,
  config: { account_id: string; user_id: string; server_url: string; instance_token: string }
) {
  const groupJid = message.chatid
  if (!groupJid) return

  const subject = chat?.wa_contactName || chat?.name || null
  const convResult = await findOrCreateGroupConversation(
    config.account_id,
    config.user_id,
    groupJid,
    subject,
    config.server_url,
    config.instance_token,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: null,
    })
  }

  const { contentText, mediaUrl, contentType } = parseMessageContent(message)

  if (message.fromMe) {
    // Echo of our own message sent from the phone/WhatsApp Web —
    // dedupe against a CRM-originated send the same way 1:1 does.
    const candidateIds = [message.id, message.messageid].filter(Boolean)
    const { data: existing } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .in('message_id', candidateIds)
      .limit(1)
      .maybeSingle()
    if (existing) return

    const { error: msgError } = await supabaseAdmin().from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'agent',
      sender_id: null,
      source: 'phone',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: message.id,
      status: 'sent',
      created_at: new Date(message.messageTimestamp).toISOString(),
    })
    if (msgError) {
      console.error('[uazapi webhook] error inserting group outbound echo:', msgError)
      return
    }
  } else {
    const senderJid = message.sender_pn || ''
    const participantPhone = normalizePhone(senderJid.split('@')[0]) || null
    const participantName = message.senderName || participantPhone || null

    // Cache the participant's photo across their messages in this
    // group instead of hitting uazapi on every single message — reuse
    // whatever the most recent prior message from them already has.
    let participantAvatarUrl: string | null = null
    if (participantPhone) {
      const { data: priorMsg } = await supabaseAdmin()
        .from('messages')
        .select('participant_avatar_url')
        .eq('conversation_id', conversation.id)
        .eq('participant_phone', participantPhone)
        .not('participant_avatar_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      participantAvatarUrl = priorMsg?.participant_avatar_url ?? null
      if (!participantAvatarUrl) {
        participantAvatarUrl = await tryFetchContactPhoto(
          config.server_url,
          config.instance_token,
          participantPhone,
        )
      }
    }

    const { error: msgError } = await supabaseAdmin().from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: message.id,
      status: 'delivered',
      created_at: new Date(message.messageTimestamp).toISOString(),
      participant_phone: participantPhone,
      participant_name: participantName,
      participant_avatar_url: participantAvatarUrl,
    })
    if (msgError) {
      console.error('[uazapi webhook] error inserting group message:', msgError)
      return
    }
  }

  const preview = message.fromMe
    ? contentText || `[${contentType}]`
    : `${message.senderName || 'Alguém'}: ${contentText || `[${contentType}]`}`

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: preview.slice(0, 200),
      last_message_at: new Date(message.messageTimestamp).toISOString(),
      unread_count: message.fromMe
        ? (conversation.unread_count || 0)
        : (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
}

/**
 * Record a message the account owner sent OUTSIDE the CRM (paired
 * phone, WhatsApp Web) so the conversation history here stays
 * complete. CRM-originated sends already exist in `messages` (written
 * synchronously by send-message.ts with uazapi's message id), so the
 * id check below drops those echoes instead of double-inserting.
 *
 * Known small race: the echo can occasionally reach us before the CRM
 * send's own insert commits, which would duplicate that one message.
 * Accepted for now — the window is milliseconds and the alternative
 * (a unique index on message_id) needs a data-cleanup migration first.
 */
async function processOutboundEcho(
  message: UazapiMessage,
  chat: UazapiChat | undefined,
  config: { account_id: string; user_id: string; server_url: string; instance_token: string }
) {
  // For fromMe events the interesting party is the chat peer —
  // sender_pn is our own number here.
  const peerPhone = normalizePhone(message.chatid.split('@')[0])
  if (!peerPhone) return

  // Dedupe against CRM-originated sends. The send API stores whichever
  // id shape uazapi returned (`id` or bare `messageid`), so match both.
  const candidateIds = [message.id, message.messageid].filter(Boolean)
  const { data: existing } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .in('message_id', candidateIds)
    .limit(1)
    .maybeSingle()
  if (existing) return

  // senderName is OUR profile name on fromMe events — only the chat
  // metadata can name the contact here.
  const contactName = chat?.wa_contactName || chat?.name || peerPhone

  const contactOutcome = await findOrCreateContact(
    config.account_id,
    config.user_id,
    peerPhone,
    contactName,
    config.server_url,
    config.instance_token,
  )
  if (!contactOutcome) return

  const convResult = await findOrCreateConversation(
    config.account_id,
    config.user_id,
    contactOutcome.contact.id,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  const { contentText, mediaUrl, contentType } = parseMessageContent(message)

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    // No CRM user to attribute — it came from the phone itself.
    sender_id: null,
    source: 'phone',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'sent',
    created_at: new Date(message.messageTimestamp).toISOString(),
  })
  if (msgError) {
    console.error('[uazapi webhook] error inserting outbound echo:', msgError)
    return
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date(message.messageTimestamp).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // A human replying from the phone is the same "yield, human is here"
  // signal as an agent replying from the CRM composer — pause any
  // active Flow run for this contact (mirrors send-message.ts).
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', config.account_id)
      .eq('contact_id', contactOutcome.contact.id)
      .eq('status', 'active')
    if (pauseErr) {
      console.error('[flows] pause-on-phone-send failed:', pauseErr.message)
    }
  } catch (err) {
    console.error('[flows] pause-on-phone-send threw:', err instanceof Error ? err.message : err)
  }
}

async function processMessage(
  message: UazapiMessage,
  chat: UazapiChat | undefined,
  config: { account_id: string; user_id: string; server_url: string; instance_token: string }
) {
  const accountId = config.account_id
  const configOwnerUserId = config.user_id
  const senderJid = message.sender_pn || message.chatid
  const senderPhone = normalizePhone(senderJid.split('@')[0])
  if (!senderPhone) {
    console.warn('[uazapi webhook] could not resolve a phone number from message', message.id)
    return
  }
  const contactName = message.senderName || chat?.wa_contactName || chat?.name || senderPhone

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
    config.server_url,
    config.instance_token,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(accountId, configOwnerUserId, contactRecord.id)
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions — best-effort: resolve the reacted-to message by trying
  // the id fields most likely to reference it, then upsert into
  // message_reactions (empty emoji = the customer removed their
  // reaction). When the target can't be resolved, log the full event
  // so the real payload shape can be read off production logs.
  if (message.messageType === 'ReactionMessage' || message.reaction) {
    try {
      const quoted = (message.quoted ?? {}) as Record<string, unknown>
      const quotedKey = quoted.key as Record<string, unknown> | undefined
      const candidates = [
        quoted.id,
        quoted.message_id,
        quoted.messageid,
        quoted.stanzaId,
        quotedKey?.id,
        message.messageid,
        message.id,
      ].filter((v): v is string => typeof v === 'string' && v.length > 0)

      let targetId: string | null = null
      for (const cand of candidates) {
        const { data } = await supabaseAdmin()
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .or(`message_id.eq.${cand},message_id.like.%:${cand}`)
          .limit(1)
          .maybeSingle()
        if (data) {
          targetId = data.id
          break
        }
      }

      if (!targetId) {
        console.warn('[uazapi webhook] reaction target not resolved — payload:', JSON.stringify(message))
        return
      }

      const emoji = (message.reaction ?? '').trim()
      if (!emoji) {
        // Reaction removed.
        await supabaseAdmin()
          .from('message_reactions')
          .delete()
          .eq('message_id', targetId)
          .eq('actor_type', 'customer')
          .is('actor_id', null)
      } else {
        // Delete-then-insert instead of upsert: the UNIQUE index treats
        // NULL actor_id rows as distinct, so ON CONFLICT never matches
        // the customer's (actor_id IS NULL) row and would duplicate.
        await supabaseAdmin()
          .from('message_reactions')
          .delete()
          .eq('message_id', targetId)
          .eq('actor_type', 'customer')
          .is('actor_id', null)
        await supabaseAdmin().from('message_reactions').insert({
          message_id: targetId,
          conversation_id: conversation.id,
          actor_type: 'customer',
          actor_id: null,
          emoji,
        })
      }
    } catch (err) {
      console.error('[uazapi webhook] reaction handling failed:', err instanceof Error ? err.message : err)
    }
    return
  }

  const { contentText, mediaUrl, contentType } = parseMessageContent(message)

  // Swipe-reply — best-effort, unconfirmed payload shape. Tries the
  // field names most likely to carry the quoted message's uazapi id
  // across Baileys-derived payload variants; logs the raw shape when
  // none match so a real payload can be diagnosed from production logs
  // instead of guessing again.
  let replyToInternalId: string | null = null
  if (message.quoted && typeof message.quoted === 'object') {
    const quoted = message.quoted as Record<string, unknown>
    const key = quoted.key as Record<string, unknown> | undefined
    const quotedId =
      quoted.id ?? quoted.message_id ?? quoted.messageid ?? quoted.stanzaId ?? key?.id

    if (typeof quotedId === 'string' && quotedId) {
      const { data } = await supabaseAdmin()
        .from('messages')
        .select('id')
        .eq('message_id', quotedId)
        .eq('conversation_id', conversation.id)
        .maybeSingle()
      replyToInternalId = data?.id ?? null
    } else {
      console.warn('[uazapi webhook] unrecognized `quoted` shape:', JSON.stringify(message.quoted))
    }
  }

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Customer tapped a button/list row on a menu we sent — uazapi
  // carries the tapped choice's id in buttonOrListid.
  const interactiveReplyId = message.buttonOrListid || null

  // uazapi doesn't always echo the tapped choice's TITLE in
  // message.text — without it the bubble falls back to a generic
  // "[Interactive reply]". The title lives in the menu WE sent, so
  // resolve it from the conversation's most recent outbound
  // interactive payload by matching the reply id. Best-effort.
  let resolvedText = contentText
  if (interactiveReplyId && !resolvedText) {
    try {
      const { data: menus } = await supabaseAdmin()
        .from('messages')
        .select('interactive_payload')
        .eq('conversation_id', conversation.id)
        .eq('content_type', 'interactive')
        .not('interactive_payload', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5)
      for (const menu of menus ?? []) {
        const p = menu.interactive_payload as {
          buttons?: { id?: string; title?: string }[]
          sections?: { rows?: { id?: string; title?: string }[] }[]
        } | null
        const choices = [
          ...(p?.buttons ?? []),
          ...(p?.sections ?? []).flatMap((s) => s.rows ?? []),
        ]
        const hit = choices.find((c) => c.id === interactiveReplyId)
        if (hit?.title) {
          resolvedText = hit.title
          break
        }
      }
    } catch (err) {
      console.warn('[uazapi webhook] tapped-choice title lookup failed:', err instanceof Error ? err.message : err)
    }
  }

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: interactiveReplyId ? 'interactive' : contentType,
    content_text: resolvedText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(message.messageTimestamp).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: resolvedText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // Notify the assigned agent about the new inbound message. Capped at
  // one UNREAD notification per conversation — a chatty customer
  // shouldn't stack ten alerts; the pending one already says "go look".
  // Best-effort: a failure here must never block message processing.
  if (conversation.assigned_agent_id) {
    try {
      const { data: pending } = await supabaseAdmin()
        .from('notifications')
        .select('id')
        .eq('conversation_id', conversation.id)
        .eq('user_id', conversation.assigned_agent_id)
        .eq('type', 'new_message_assigned')
        .is('read_at', null)
        .limit(1)
        .maybeSingle()

      if (!pending) {
        const { error: notifErr } = await supabaseAdmin().from('notifications').insert({
          account_id: accountId,
          user_id: conversation.assigned_agent_id,
          type: 'new_message_assigned',
          conversation_id: conversation.id,
          contact_id: contactRecord.id,
          title: 'New message in your conversation',
          body: `${contactRecord.name || senderPhone}: ${(resolvedText || `[${contentType}]`).slice(0, 120)}`,
        })
        if (notifErr) console.error('[notifications] new_message_assigned insert failed:', notifErr.message)
      }
    } catch (err) {
      console.error('[notifications] new_message_assigned threw:', err instanceof Error ? err.message : err)
    }
  }

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: resolvedText ?? '',
          meta_message_id: message.id,
        }
      : { kind: 'text', text: resolvedText ?? '', meta_message_id: message.id },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = resolvedText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too, which
    // enables automation-only chained menus. When a Flow owns the menu
    // it will have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: resolvedText,
  })
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive', 'sticker',
])

/** uazapi mediaType → our content_type + `/api/whatsapp/media/:id` proxy URL. */
function parseMessageContent(message: UazapiMessage): {
  contentText: string | null
  mediaUrl: string | null
  contentType: string
} {
  if (!message.mediaType) {
    return { contentText: message.text || null, mediaUrl: null, contentType: 'text' }
  }

  // ptt (voice note) renders identically to audio in the inbox;
  // sticker is first-class since migration 040 (frameless render).
  let contentType =
    message.mediaType === 'ptt' ? 'audio'
    : ALLOWED_CONTENT_TYPES.has(message.mediaType) ? message.mediaType
    : ''

  // fromMe echoes (and possibly other variants) carry mediaType values
  // outside the known set — fall back to the raw Baileys messageType
  // name. A media message must NEVER collapse to 'text': the text
  // bubble ignores media_url entirely and renders empty.
  if (!contentType) {
    const raw = (message.messageType || '').toLowerCase()
    contentType =
      raw.includes('sticker') ? 'sticker'
      : raw.includes('image') ? 'image'
      : raw.includes('video') ? 'video'
      : raw.includes('audio') || raw.includes('ptt') ? 'audio'
      : raw.includes('document') ? 'document'
      : 'document'
    console.warn(
      `[uazapi webhook] unrecognized mediaType "${message.mediaType}" (messageType "${message.messageType}") — stored as ${contentType}`,
    )
  }

  return {
    contentText: message.text || null,
    // Lazy proxy — the media route fetches bytes from uazapi's
    // /message/download on demand (see downloadMedia in uazapi-api.ts),
    // same pattern the Meta version used for its media IDs.
    mediaUrl: `/api/whatsapp/media/${encodeURIComponent(message.id)}`,
    contentType,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

/**
 * Best-effort fetch of a contact's WhatsApp profile photo. Never
 * throws — a failure here (contact has no photo, uazapi hiccup, rate
 * limit) must not block message processing.
 */
async function tryFetchContactPhoto(
  serverUrl: string,
  encryptedInstanceToken: string,
  phone: string,
): Promise<string | null> {
  try {
    const instanceToken = decrypt(encryptedInstanceToken)
    return await getContactPhoto({ serverUrl, instanceToken, phone })
  } catch (err) {
    console.warn('[uazapi webhook] contact photo fetch failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
  serverUrl: string,
  encryptedInstanceToken: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    const updates: Record<string, unknown> = {}
    if (name && name !== existingContact.name) updates.name = name
    if (!existingContact.avatar_url) {
      const photo = await tryFetchContactPhoto(serverUrl, encryptedInstanceToken, phone)
      if (photo) updates.avatar_url = photo
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString()
      await supabaseAdmin().from('contacts').update(updates).eq('id', existingContact.id)
      Object.assign(existingContact, updates)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const avatarUrl = await tryFetchContactPhoto(serverUrl, encryptedInstanceToken, phone)

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
      avatar_url: avatarUrl,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existing } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) {
    return { conversation: existing, created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({ account_id: accountId, user_id: configOwnerUserId, contact_id: contactId })
    .select()
    .single()

  if (createError) {
    // Unique index (migration 037): a concurrent webhook invocation —
    // typical when a bot sends a burst of messages — won the insert
    // race. Re-fetch the winner instead of dropping this message.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .maybeSingle()
      if (raced) return { conversation: raced, created: false }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
