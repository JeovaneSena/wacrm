// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends via the account's uazapi instance,
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendMediaMessage,
  sendMenuMessage,
  type MediaKind,
} from '@/lib/whatsapp/uazapi-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  interactivePayloadToMenu,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  /**
   * The human agent sending this message (dashboard composer only —
   * omitted for public-API sends, which have no signed-in user).
   * Persisted as `messages.sender_id` so the dashboard's per-agent
   * SLA/volume breakdown has someone to attribute the reply to.
   */
  senderId?: string | null;
  /**
   * Where this send originated — 'crm' (dashboard composer, the
   * default) or 'api' (public /api/v1/messages). Persisted as
   * `messages.source` so the inbox can badge non-CRM sends.
   */
  source?: 'crm' | 'api';
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** uazapi's message id for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, interactivePayload } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  // Interactive: validate the full structured payload up front so a
  // bad payload 400s before we touch the gateway.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // WhatsApp caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    interactivePayload,
    replyToMessageId,
    senderId,
    source,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const isGroup = conversation.chat_type === 'group';
  const contact = conversation.contact;

  // Groups send to the raw WhatsApp group JID (e.g.
  // "123456-789@g.us") — sanitizePhoneForMeta/isValidE164 are E.164
  // phone checks and would mangle/reject a JID, so they're skipped
  // entirely for this path.
  let sanitizedPhone: string;
  if (isGroup) {
    if (!conversation.group_jid) {
      throw new SendMessageError('bad_request', 'Group JID not found', 400);
    }
    sanitizedPhone = conversation.group_jid;
  } else {
    if (!contact?.phone) {
      throw new SendMessageError(
        'bad_request',
        'Contact phone number not found',
        400
      );
    }
    sanitizedPhone = sanitizePhoneForMeta(contact.phone);
    if (!isValidE164(sanitizedPhone)) {
      throw new SendMessageError(
        'bad_request',
        'Invalid phone number format',
        400
      );
    }
  }

  // WhatsApp config, account-scoped.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config || !config.instance_token) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const instanceToken = decrypt(config.instance_token);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.instance_token)) {
    void db
      .from('whatsapp_config')
      .update({ instance_token: encrypt(instanceToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] instance_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its uazapi message id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no uazapi message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'interactive') {
      const menu = interactivePayloadToMenu(interactivePayload!);
      const result = await sendMenuMessage({
        serverUrl: config.server_url,
        instanceToken,
        to: phone,
        type: menu.type,
        text: menu.text,
        footerText: menu.footerText,
        listButton: menu.listButton,
        choices: menu.choices,
        replyId: contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        serverUrl: config.server_url,
        instanceToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        replyId: contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      serverUrl: config.server_url,
      instanceToken,
      to: phone,
      text: contentText!,
      replyId: contextMessageId,
    });
    return result.messageId;
  };

  let waMessageId = '';
  try {
    waMessageId = await attempt(sanitizedPhone);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown uazapi API error';
    console.error('[send-message] uazapi send failed:', message);
    throw new SendMessageError('uazapi_error', `uazapi API error: ${message}`, 502);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  const interactiveBody =
    messageType === 'interactive' ? interactivePayload!.body : null;

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: senderId || null,
      source: source ?? 'crm',
      content_type: messageType,
      content_text: interactiveBody ?? contentText ?? null,
      media_url: mediaUrl || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : contentText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort. No-op
  // for groups: there's no contact to key a flow run on, and flows
  // never run in groups in the first place.
  try {
    if (!isGroup && contact) {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
