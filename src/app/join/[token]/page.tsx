'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Five UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
// Peek and auth resolve INDEPENDENTLY (two separate effects/fetches) —
// auth.getUser() is a real network round trip to Supabase's auth
// server, not a local cache read, so gating the whole page behind
// both meant a slow/stuck auth call kept the spinner up long after
// peek had already answered (even with an error). Only the "Accept"
// button waits on auth now; everything else renders off peek alone.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ loading       │ card + disabled button   │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';
import { parsePeekResponse, type PeekResult } from '@/lib/auth/invite-peek';

export default function JoinPage() {
  const t = useTranslations('JoinInvite');
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` and `/signup` do.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Peek and auth are resolved independently — previously a single
  // `Promise.all` gated the whole page behind BOTH finishing, so a
  // slow/stuck `auth.getUser()` (a real network round trip to
  // Supabase's auth server, not a local cache read) kept the spinner
  // up long after the peek had already come back, even with an error.
  // Each one now updates its own state as soon as it resolves.
  const loadPeek = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const peekRes = await fetch(
          `/api/invitations/${encodeURIComponent(token)}/peek`,
          { cache: 'no-store', signal },
        );
        const peekBody = await parsePeekResponse(peekRes);
        if (signal?.aborted) return;
        setPeek(peekBody);
      } catch (err) {
        if (signal?.aborted) return;
        console.error('[join] peek error:', err);
        setPeek({ ok: false, reason: 'server_error' });
      }
    },
    [token],
  );

  const loadAuth = useCallback(async (signal?: AbortSignal) => {
    try {
      const authRes = await createClient().auth.getUser();
      if (signal?.aborted) return;
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      if (signal?.aborted) return;
      console.error('[join] auth error:', err);
      setAuthedUserId(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPeek(controller.signal);
    return () => controller.abort();
  }, [loadPeek]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAuth(controller.signal);
    return () => controller.abort();
  }, [loadAuth]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use different email)
        // rather than a 3-second toast.
        if (res.status === 409) {
          setConflictMessage(payload.error || t('conflictDefault'));
        } else {
          toast.error(payload.error || t('errAccept'));
        }
        setAccepting(false);
        return;
      }
      toast.success(t('welcome'));
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error(t('errServer'));
      setAccepting(false);
    }
  }, [token, t]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error(t('errSignOut'));
      setSigningOut(false);
    }
  }, [t]);

  // ----- Loading state (peek pending). Auth resolving separately no
  // longer blocks this — see the "Peek OK" branch below. -----
  if (peek === null) {
    return (
      <Card className="w-full max-w-md border-border bg-card shadow-xl shadow-black/20">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('verifying')}</p>
        </CardContent>
      </Card>
    );
  }

  // ----- New-account invite: this page is for joining the inviter's
  // team; a workspace-creation invite is handled entirely by /signup.
  // Redirect there carrying the token. -----
  if (peek.ok && peek.kind === 'new_account') {
    if (typeof window !== 'undefined') {
      window.location.replace(`/signup?invite=${encodeURIComponent(token ?? '')}`);
    }
    return (
      <Card className="w-full max-w-md border-border bg-card shadow-xl shadow-black/20">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('verifying')}</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    return (
      <Card className="w-full max-w-md border-border bg-card shadow-xl shadow-black/20">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">{t(`fail_${peek.reason}_title`)}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t(`fail_${peek.reason}_body`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is
              the right primary action; the "create account" /
              "sign in" links stay as secondary options. Other
              failure reasons (not_found / used / expired) are
              terminal for this token, so no retry — just the
              signup/sign-in escape hatches. */}
          {peek.reason === 'server_error' || peek.reason === 'rate_limited' ? (
            <>
              <Button
                onClick={() => {
                  setPeek(null);
                  void loadPeek();
                }}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('tryAgain')}
              </Button>
              <Link href="/signup">
                <Button
                  variant="outline"
                  className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('createInstead')}
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup">
                <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                  {t('createInstead')}
                </Button>
              </Link>
              <Link href="/login">
                <Button
                  variant="outline"
                  className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('signIn')}
                </Button>
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <UsersRound className="h-6 w-6 text-primary" />
      </div>
      <CardTitle className="text-xl text-foreground">
        {t.rich('invitedTo', {
          account: peek.account_name,
          b: (c) => <span className="text-primary">{c}</span>,
        })}
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        {t.rich('joinAs', {
          validUntil: new Date(peek.expires_at).toLocaleDateString('pt-BR', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }),
          badge: () => (
            <span className="inline-flex items-center gap-1 text-foreground">
              <ShieldCheck className="size-3.5 text-primary" />
              {t(`role_${peek.role}`)}
            </span>
          ),
        })}
      </CardDescription>
    </CardHeader>
  );

  // ----- Auth still resolving: invite card renders immediately (peek
  // already answered), only the action button waits on auth. Avoids
  // blocking the whole page behind a slow/stuck auth.getUser() call. -----
  if (authedUserId === undefined) {
    return (
      <Card className="w-full max-w-md border-border bg-card shadow-xl shadow-black/20">
        {inviteHeader}
        <CardContent className="flex flex-col gap-3">
          <Button disabled className="w-full bg-primary text-primary-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('verifying')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <Card className="w-full max-w-md border-border bg-card shadow-xl shadow-black/20">
          {inviteHeader}
          <CardContent className="flex flex-col gap-3">
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {accepting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('accepting')}
                </>
              ) : (
                <>
                  <CheckCircle className="size-4" />
                  {t('accept')}
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t.rich('acceptNote', {
                account: peek.account_name,
                b: (c) => <span className="text-muted-foreground">{c}</span>,
              })}
            </p>
          </CardContent>
        </Card>

        {/* Conflict modal — opens when the redeem endpoint returns 409
            (caller already in a shared account or has domain data).
            Blocks the flow until the user picks a recovery action so
            they aren't stuck retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 text-amber-400" />
                {t('conflictTitle', { account: peek.account_name })}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              <p>
                {t.rich('conflictBody', {
                  account: peek.account_name,
                  b: (c) => <span className="text-popover-foreground">{c}</span>,
                })}
              </p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => setConflictMessage(null)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                {t('staySignedIn')}
              </Button>
              <Button
                onClick={handleSignOutAndRetry}
                disabled={signingOut}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('signingOut')}
                  </>
                ) : (
                  t('signOutDifferent')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed: prompt to sign up or sign in -----
  return (
    <Card className="w-full max-w-md border-border bg-card shadow-xl shadow-black/20">
      {inviteHeader}
      <CardContent className="flex flex-col gap-2">
        <Link href={`/signup?invite=${encodeURIComponent(token!)}`}>
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
            {t('createJoin')}
          </Button>
        </Link>
        <Link href={`/login?invite=${encodeURIComponent(token!)}`}>
          <Button
            variant="outline"
            className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t('haveAccount')}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
