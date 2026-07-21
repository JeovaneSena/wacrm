import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { deleteMessage } from '@/lib/whatsapp/uazapi-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// WhatsApp only allows delete-for-everyone within a short window after
// send. uazapi enforces this server-side too, but failing fast here
// gives a clearer message than waiting on a 502 from uazapi.
const DELETE_WINDOW_MS = 15 * 60 * 1000;

/**
 * POST /api/whatsapp/delete
 *
 * Body: { message_id: <internal UUID> }
 *
 * Delete-for-everyone. Only messages sent by an agent/bot (never a
 * customer's own message) and only within DELETE_WINDOW_MS of send.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`delete:${user.id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { message_id } = body as { message_id?: string };

    if (!message_id) {
      return NextResponse.json(
        { error: 'message_id is required' },
        { status: 400 },
      );
    }

    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id, sender_type, created_at, deleted_at')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (targetMessage.sender_type !== 'agent' && targetMessage.sender_type !== 'bot') {
      return NextResponse.json(
        { error: 'Only messages sent by your team can be deleted' },
        { status: 403 },
      );
    }

    if (targetMessage.deleted_at) {
      return NextResponse.json({ success: true });
    }

    if (!targetMessage.message_id) {
      return NextResponse.json(
        { error: 'Cannot delete a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const sentAt = new Date(targetMessage.created_at).getTime();
    if (Date.now() - sentAt > DELETE_WINDOW_MS) {
      return NextResponse.json(
        { error: 'It is no longer possible to delete this message (delete window expired)' },
        { status: 409 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, chat_type, group_jid, contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    let to: string;
    if (conversation.chat_type === 'group' && conversation.group_jid) {
      to = conversation.group_jid;
    } else {
      const contact = Array.isArray(conversation.contact)
        ? conversation.contact[0]
        : conversation.contact;
      if (!contact?.phone) {
        return NextResponse.json(
          { error: 'Contact phone number not found' },
          { status: 400 },
        );
      }
      to = sanitizePhoneForMeta(contact.phone);
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('server_url, instance_token')
      .eq('account_id', accountId)
      .single();

    if (configError || !config || !config.instance_token) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const instanceToken = decrypt(config.instance_token);

    try {
      await deleteMessage({
        serverUrl: config.server_url,
        instanceToken,
        to,
        targetMessageId: targetMessage.message_id,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown uazapi API error';
      console.error('[whatsapp/delete] uazapi delete failed:', message);
      return NextResponse.json(
        { error: `uazapi API error: ${message}` },
        { status: 502 },
      );
    }

    const { error: updateError } = await supabase
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', targetMessage.id);

    if (updateError) {
      console.error('[whatsapp/delete] DB update failed:', updateError.message);
      return NextResponse.json(
        { error: 'Message deleted on WhatsApp but DB update failed' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp delete POST:', error);
    return NextResponse.json(
      { error: 'Failed to delete message' },
      { status: 500 },
    );
  }
}
