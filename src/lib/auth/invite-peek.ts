/**
 * Shared client-side parser for `GET /api/invitations/[token]/peek`
 * responses. The endpoint only returns the `{ok, reason?}` shape on
 * 2xx — a 429 (rate limit) or any other non-OK status returns a
 * differently-shaped body (`{error, ...}`), which if cast straight to
 * `PeekResult` renders as `fail_undefined_title` (peek.reason is
 * literally `undefined`). Checking `res.status`/`res.ok` first keeps
 * every caller on a valid i18n key.
 *
 * Used by both `/join/[token]` and `/signup` — previously duplicated
 * verbatim between the two, which is how the 429 fix landed in one
 * copy and not the other.
 */

export interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  /** 'member' joins the inviter's account; 'new_account' authorizes
   *  creating an independent workspace (handled on /signup). */
  kind?: 'member' | 'new_account';
  expires_at: string;
}

export interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error' | 'rate_limited';
}

export type PeekResult = PeekOk | PeekFail;

export async function parsePeekResponse(res: Response): Promise<PeekResult> {
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (!res.ok) return { ok: false, reason: 'server_error' };
  const body = await res.json().catch(() => null);
  if (body && typeof body === 'object' && 'ok' in body) return body as PeekResult;
  return { ok: false, reason: 'server_error' };
}
