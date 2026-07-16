"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { playUnreadPing } from "@/lib/notify-sound";

const BASE_TITLE = "CRM SenaAutomações";

/**
 * Headless — no JSX. Mirrors the brand icon (`src/app/icon.tsx`,
 * purple rounded square) into a canvas and stamps a red count badge
 * on it, then swaps the <head> favicon link at runtime. Next's
 * static `icon.tsx` route still serves the *default* favicon (no
 * badge) — this only overrides it client-side while unread > 0.
 */
function updateFaviconAndTitle(unread: number) {
  if (typeof document === "undefined") return;

  document.title = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${BASE_TITLE}` : BASE_TITLE;

  let link = document.querySelector<HTMLLinkElement>("link[rel='icon'][data-dynamic]");
  if (unread === 0) {
    link?.remove();
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#7c3aed";
  ctx.beginPath();
  ctx.roundRect(0, 0, 32, 32, 6);
  ctx.fill();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Same chat-bubble glyph as icon.tsx, scaled to this canvas.
  ctx.moveTo(21, 15);
  ctx.arc(19, 15, 2, Math.PI * 1.5, Math.PI * 0.5, true);
  ctx.lineTo(7, 17);
  ctx.lineTo(3, 21);
  ctx.lineTo(3, 5);
  ctx.arc(5, 5, 2, Math.PI, Math.PI * 1.5);
  ctx.lineTo(19, 3);
  ctx.arc(19, 5, 2, Math.PI * 1.5, 0);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(24, 8, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 9px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(unread > 9 ? "9+" : String(unread), 24, 8.5);

  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.dataset.dynamic = "true";
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL("image/png");
}

/** Headless — drives the tab title, favicon badge, and unread ping
 *  sound from a single shared `useTotalUnread()` subscription. */
function UnreadIndicators({ totalUnread }: { totalUnread: number }) {
  const prevRef = useRef(totalUnread);

  useEffect(() => {
    updateFaviconAndTitle(totalUnread);
    // Only ping when the count goes up (a new unread arrived), never
    // when it drops (the agent just read something).
    if (totalUnread > prevRef.current) playUnreadPing();
    prevRef.current = totalUnread;
  }, [totalUnread]);

  useEffect(() => {
    return () => updateFaviconAndTitle(0);
  }, []);

  return null;
}

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  const { user, loading } = useAuth();
  const router = useRouter();
  const totalUnread = useTotalUnread();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <UnreadIndicators totalUnread={totalUnread} />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} totalUnread={totalUnread} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
