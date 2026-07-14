import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';

/**
 * Find-or-create the conversation for a contact and return its id.
 *
 * Client-side twin of the send route's `findOrCreateConversation`
 * (src/app/api/whatsapp/send/route.ts) — used by the "New conversation"
 * dialog in the inbox and the "Send message" row action in Contacts,
 * where we want to open the thread WITHOUT sending anything yet.
 *
 * Runs under the caller's RLS: the conversations_insert policy requires
 * agent+ membership of the account, so viewers fail here (the UI hides
 * the affordance from them anyway via useCan('send-messages')).
 *
 * Race-safe: if the webhook (or a teammate) creates the conversation
 * between our select and insert, the unique constraint rejects the
 * duplicate and we re-select the winner instead of failing.
 */
export async function openConversation(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string> {
  const { data: existing, error: findError } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to look up conversation: ${findError.message}`);
  }
  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single();

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      const { data: raced } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .maybeSingle();
      if (raced) return raced.id;
    }
    throw new Error(`Failed to create conversation: ${insertError.message}`);
  }

  return created.id;
}
