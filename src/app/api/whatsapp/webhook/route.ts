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
  // fromMe: we sent this via the paired phone directly (not via this
  // CRM's send API, which persists synchronously in send-message.ts).
  // Mirroring it here would double-insert — skip.
  if (message.fromMe) return

  // Groups aren't modeled in this CRM's contact/conversation schema
  // (conversations are 1:1 per contact.phone) — same scope the Meta
  // Cloud API version had, since Meta's API has no group concept at
  // all. Skip rather than mis-attribute a group thread to one contact.
  if (message.isGroup) return

  await processMessage(message, body.chat, config)
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

  // Reactions — best-effort, unconfirmed payload shape (see file-top
  // comment). Skip rather than risk mis-storing garbage.
  if (message.messageType === 'ReactionMessage' || message.reaction) {
    console.warn(
      '[uazapi webhook] reaction event received but shape is unconfirmed — skipping',
      message.id
    )
    return
  }

  const { contentText, mediaUrl, contentType } = parseMessageContent(message)

  // Swipe-reply — best-effort, unconfirmed payload shape.
  let replyToInternalId: string | null = null
  if (message.quoted && typeof message.quoted === 'object') {
    const quotedId = (message.quoted as Record<string, unknown>).id
    if (typeof quotedId === 'string' && quotedId) {
      const { data } = await supabaseAdmin()
        .from('messages')
        .select('id')
        .eq('message_id', quotedId)
        .eq('conversation_id', conversation.id)
        .maybeSingle()
      replyToInternalId = data?.id ?? null
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

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: interactiveReplyId ? 'interactive' : contentType,
    content_text: contentText,
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
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : { kind: 'text', text: contentText ?? '', meta_message_id: message.id },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? ''
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
    text: contentText,
  })
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive',
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

  // sticker/ptt aren't valid `messages.content_type` values (CHECK
  // constraint) — map to their closest allowed type. ptt (voice note)
  // and audio both render the same way in the inbox.
  const contentType =
    message.mediaType === 'sticker' ? 'image'
    : message.mediaType === 'ptt' ? 'audio'
    : ALLOWED_CONTENT_TYPES.has(message.mediaType) ? message.mediaType
    : 'text'

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
