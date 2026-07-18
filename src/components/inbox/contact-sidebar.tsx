"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type {
  Contact,
  CustomField,
  Deal,
  ContactNote,
  PipelineStage,
  Tag,
} from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Building2,
  CalendarDays,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DealForm } from "@/components/pipelines/deal-form";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useTranslations } from "next-intl";

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Account-wide tag list for the add-tag dropdown, plus custom-field
  // values (read-only surface; editing stays in the Contacts tab).
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  // "Add deal" reuses the pipelines DealForm — it needs the pipeline +
  // its stages, fetched lazily the first time the button is clicked.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [pipelineId, setPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    const [dealsRes, notesRes, tagsRes, allTagsRes, fieldsRes, valuesRes] =
      await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", contact.id),
        supabase.from("tags").select("*").order("name"),
        supabase.from("custom_fields").select("*").order("field_name"),
        supabase
          .from("contact_custom_values")
          .select("*")
          .eq("contact_id", contact.id),
      ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    if (allTagsRes.data) setAllTags(allTagsRes.data);
    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      for (const v of valuesRes.data) map[v.custom_field_id] = v.value ?? "";
      setCustomValues(map);
    }
  }, [contact]);

  const handleToggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact || !accountId) return;
      const supabase = createClient();
      const existing = tags.find((t) => t.id === tag.id);
      if (existing) {
        // Optimistic remove.
        setTags((prev) => prev.filter((t) => t.id !== tag.id));
        const { error } = await supabase
          .from("contact_tags")
          .delete()
          .eq("id", existing.contact_tag_id);
        if (error) fetchContactData();
      } else {
        const { data, error } = await supabase
          .from("contact_tags")
          .insert({ contact_id: contact.id, tag_id: tag.id })
          .select("id")
          .single();
        if (!error && data) {
          setTags((prev) => [...prev, { ...tag, contact_tag_id: data.id }]);
        }
      }
    },
    [contact, accountId, tags, fetchContactData],
  );

  const handleOpenDealForm = useCallback(async () => {
    const supabase = createClient();
    // Lazy-load the first pipeline + stages once; reuse afterwards.
    if (!pipelineId) {
      const { data: pipelines } = await supabase
        .from("pipelines")
        .select("id")
        .order("created_at")
        .limit(1);
      const pid = pipelines?.[0]?.id;
      if (!pid) return; // no pipeline yet — Funis tab seeds one on first visit
      const { data: stageRows } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pid)
        .order("position");
      setPipelineId(pid);
      setStages(stageRows ?? []);
    }
    setDealFormOpen(true);
  }, [pipelineId]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{contact.email || "—"}</span>
            </div>

            <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{contact.company || "—"}</span>
            </div>

            {contact.created_at && (
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground"
                title={tSidebar("customerSince")}
              >
                <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {tSidebar("customerSince")}{" "}
                  {format(new Date(contact.created_at), "d MMM yyyy", { locale: ptBR })}
                </span>
              </div>
            )}

            {/* Custom fields with a value — read-only surface here;
                editing lives in the Contacts tab detail view. */}
            {customFields
              .filter((f) => customValues[f.id])
              .map((f) => (
                <div
                  key={f.id}
                  className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground"
                >
                  <span className="block text-[10px] uppercase tracking-wider">
                    {f.field_name}
                  </span>
                  <span className="truncate text-foreground">{customValues[f.id]}</span>
                </div>
              ))}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags — click a pill to remove, "+" to add from the
              account's tag list. */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              <span className="flex-1">{tSidebar("tags")}</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  title={tSidebar("addTag")}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="border-border bg-popover">
                  {allTags.length === 0 ? (
                    <DropdownMenuItem disabled>{tSidebar("noTagsAccount")}</DropdownMenuItem>
                  ) : (
                    allTags.map((tag) => {
                      const active = tags.some((t) => t.id === tag.id);
                      return (
                        <DropdownMenuItem key={tag.id} onClick={() => handleToggleTag(tag)}>
                          <span
                            className="mr-2 h-2 w-2 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="flex-1">{tag.name}</span>
                          {active && <Check className="ml-2 h-3 w-3 text-primary" />}
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <button
                    key={tag.contact_tag_id}
                    type="button"
                    onClick={() => handleToggleTag(tag)}
                    title={tSidebar("removeTag")}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-70"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              <span className="flex-1">{tSidebar("deals")}</span>
              <button
                type="button"
                onClick={() => void handleOpenDealForm()}
                title={tSidebar("addDeal")}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "d MMM yyyy HH:mm", { locale: ptBR })}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* "Add deal" — pipelines' DealForm, pre-linked to this contact. */}
      {pipelineId && stages.length > 0 && (
        <DealForm
          open={dealFormOpen}
          onOpenChange={setDealFormOpen}
          pipelineId={pipelineId}
          stages={stages}
          defaultContactId={contact.id}
          onSaved={() => {
            setDealFormOpen(false);
            fetchContactData();
          }}
        />
      )}
    </div>
  );
}
