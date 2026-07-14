'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquare, Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { openConversation } from '@/lib/inbox/open-conversation';
import { ContactForm } from '@/components/contacts/contact-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ContactResult {
  id: string;
  name: string | null;
  phone: string;
  company: string | null;
}

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the (found-or-created) conversation id to navigate to. */
  onOpenConversation: (conversationId: string) => void;
}

/**
 * "New conversation" picker — search the account's contacts (or create
 * one inline via ContactForm) and open their thread. The conversation
 * row is found-or-created client-side (openConversation); no message
 * is sent until the user types one in the composer.
 */
export function NewConversationDialog({
  open,
  onOpenChange,
  onOpenConversation,
}: NewConversationDialogProps) {
  const t = useTranslations('Inbox.newConversation');
  const { user, accountId } = useAuth();

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ContactResult[]>([]);
  const [loading, setLoading] = useState(false);
  /** Contact id currently being opened — disables the whole list. */
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [contactFormOpen, setContactFormOpen] = useState(false);

  // Debounced contact search. Empty query → 20 most recent contacts,
  // so the list is useful the moment the dialog opens.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;

    const timer = setTimeout(async () => {
      setLoading(true);
      const supabase = createClient();
      const q = search.trim();
      let query = supabase
        .from('contacts')
        .select('id, name, phone, company')
        .eq('account_id', accountId)
        .limit(20);
      query = q
        ? query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`).order('name')
        : query.order('created_at', { ascending: false });

      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        console.error('[new-conversation] contact search failed:', error.message);
        setResults([]);
      } else {
        setResults((data as ContactResult[]) ?? []);
      }
      setLoading(false);
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, accountId, search]);

  // Reset transient state on close so the next open starts clean —
  // done in the change handler (not an effect) to avoid a cascading
  // render on every open.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSearch('');
        setOpeningId(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handlePick = useCallback(
    async (contactId: string) => {
      if (!user || !accountId || openingId) return;
      setOpeningId(contactId);
      try {
        const supabase = createClient();
        const conversationId = await openConversation(
          supabase,
          accountId,
          user.id,
          contactId,
        );
        handleOpenChange(false);
        onOpenConversation(conversationId);
      } catch (err) {
        console.error('[new-conversation] open failed:', err);
        toast.error(t('error'));
        setOpeningId(null);
      }
    },
    [user, accountId, openingId, handleOpenChange, onOpenConversation, t],
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="border-border bg-muted pl-9 text-sm"
            />
          </div>

          <div className="max-h-72 min-h-24 overflow-y-auto rounded-lg border border-border">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <p className="text-sm text-muted-foreground">{t('noResults')}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {results.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      disabled={!!openingId}
                      onClick={() => handlePick(c.id)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                        {(c.name || c.phone).charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {c.name || c.phone}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.name ? c.phone : c.company || ''}
                        </span>
                      </span>
                      {openingId === c.id ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Button
            variant="outline"
            onClick={() => setContactFormOpen(true)}
            className="border-border text-muted-foreground hover:text-foreground"
          >
            <UserPlus className="size-4" />
            {t('newContact')}
          </Button>
        </DialogContent>
      </Dialog>

      <ContactForm
        open={contactFormOpen}
        onOpenChange={setContactFormOpen}
        onSaved={(contactId) => {
          // Open the just-created contact's thread straight away.
          if (contactId) void handlePick(contactId);
        }}
      />
    </>
  );
}
