"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Conversation } from "@/types";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Drives the sidebar badge, the tab-title/favicon
 * counter, and the unread ping sound.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 *
 * Realtime alone is not enough: a dropped WebSocket or a throttled
 * background tab silently loses UPDATE events and the count freezes at
 * a stale value (users saw a "9+" badge with zero unread rows in the
 * DB). So the full recount also re-runs on tab-visible / window-focus
 * and whenever the channel (re)subscribes — same safety-net idea the
 * inbox page uses with its resync token.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Full recount. RLS scopes this to the signed-in user automatically —
    // no explicit user_id filter needed here.
    const refetch = async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, unread_count");
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of data as { id: string; unread_count: number }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    };

    void refetch();

    const channel = supabase
      .channel("total-unread-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            map.set(row.id, row.unread_count ?? 0);
          }
          // Recompute — cheap, conversations per user stay small.
          let sum = 0;
          for (const n of map.values()) if (n > 0) sum += 1;
          setTotal(sum);
        },
      )
      .subscribe((status) => {
        // A (re)subscribe means we may have missed events while the
        // socket was down — recount from the source of truth.
        if (status === "SUBSCRIBED") void refetch();
      });

    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const onFocus = () => void refetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      supabase.removeChannel(channel);
    };
  }, []);

  return total;
}
