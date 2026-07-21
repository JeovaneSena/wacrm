/**
 * UAZAPI (uazapiGO) helpers — a self-hosted, QR-paired WhatsApp
 * gateway. Replaces the Meta Cloud API transport (`meta-api.ts`) as
 * this CRM's only WhatsApp connection method.
 *
 * Every function takes a single options object (named parameters),
 * mirroring meta-api.ts's convention.
 *
 * Response shapes below were confirmed against a live uazapiGO server
 * (2026-07-10), not just the vendor's Postman collection — the
 * collection ships requests only, no response bodies.
 */

export interface UazapiErrorResponse {
  error?: string
  message?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    if (data.error) message = data.error
    else if (data.message) message = data.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface UazapiInstance {
  id: string
  token: string
  /** 'disconnected' | 'connecting' | 'connected' */
  status: string
  /** data:image/png;base64,... — present while status is 'connecting'. */
  qrcode: string
  /** Present when a phone-number pairing code was requested instead of a QR. */
  paircode: string
  name: string
  /** The paired WhatsApp number, e.g. "557391690494". Empty until connected. */
  owner: string
  profileName: string
  profilePicUrl: string
}

export interface InitInstanceArgs {
  serverUrl: string
  /** The uazapiGO server's admin token — only needed to CREATE an instance. */
  adminToken: string
  name: string
}

/**
 * Create a new uazapi instance. Returns the instance's own `token`,
 * which scopes every subsequent call (connect/status/send/...) to
 * this one WhatsApp number and never requires the admin token again.
 */
export async function initInstance(
  args: InitInstanceArgs,
): Promise<UazapiInstance> {
  const { serverUrl, adminToken, name } = args
  const response = await fetch(`${serverUrl}/instance/init`, {
    method: 'POST',
    headers: { admintoken: adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return data.instance
}

export interface InstanceTokenArgs {
  serverUrl: string
  instanceToken: string
}

/**
 * Start (or resume) pairing. Returns a fresh QR code (or, if `phone`
 * is passed, a pairing code instead) in `instance.qrcode` /
 * `instance.paircode`.
 */
export async function connectInstance(
  args: InstanceTokenArgs & { phone?: string },
): Promise<UazapiInstance> {
  const { serverUrl, instanceToken, phone } = args
  const response = await fetch(`${serverUrl}/instance/connect`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(phone ? { phone } : {}),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return data.instance
}

/** Poll pairing / connection state. Also returns a live QR while pairing. */
export async function getInstanceStatus(
  args: InstanceTokenArgs,
): Promise<UazapiInstance> {
  const { serverUrl, instanceToken } = args
  const response = await fetch(`${serverUrl}/instance/status`, {
    headers: { token: instanceToken },
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return data.instance
}

export async function disconnectInstance(args: InstanceTokenArgs): Promise<void> {
  const { serverUrl, instanceToken } = args
  const response = await fetch(`${serverUrl}/instance/disconnect`, {
    method: 'POST',
    headers: { token: instanceToken },
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
}

/** Fully deletes the instance server-side (used by "Reset Configuration"). */
export async function deleteInstance(args: InstanceTokenArgs): Promise<void> {
  const { serverUrl, instanceToken } = args
  const response = await fetch(`${serverUrl}/instance`, {
    method: 'DELETE',
    headers: { token: instanceToken },
  })
  // A 404 here means it's already gone — treat as success.
  if (response.status === 404) return
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
}

// ============================================================
// Webhook registration
// ============================================================

export interface SetWebhookArgs extends InstanceTokenArgs {
  url: string
  enabled?: boolean
}

/**
 * Point this instance's inbound events at our webhook route.
 * `events` is fixed to what processMessage/handleStatus actually
 * consume — narrower than the Postman example, which subscribes to
 * everything.
 */
export async function setInstanceWebhook(args: SetWebhookArgs): Promise<void> {
  const { serverUrl, instanceToken, url, enabled = true } = args
  const response = await fetch(`${serverUrl}/webhook`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled,
      url,
      events: ['messages', 'messages_update', 'connection'],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
}

// ============================================================
// Contact lookup
// ============================================================

/**
 * Fetch a contact's WhatsApp profile photo URL (confirmed live against
 * a uazapiGO server 2026-07-13). Always 200s, even for an unknown or
 * photo-less number — `image` is just `""` in that case, never a 404.
 */
export async function getContactPhoto(
  args: InstanceTokenArgs & { phone: string },
): Promise<string | null> {
  const { serverUrl, instanceToken, phone } = args
  const response = await fetch(`${serverUrl}/chat/GetNameAndImageURL`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: phone }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return data.image || null
}

// ============================================================
// Sending
// ============================================================

export interface UazapiSendResult {
  messageId: string
}

export interface SendTextMessageArgs extends InstanceTokenArgs {
  to: string
  text: string
  /** uazapi's internal message id to quote (their "id" or "messageid" field). */
  replyId?: string
}

export async function sendTextMessage(
  args: SendTextMessageArgs,
): Promise<UazapiSendResult> {
  const { serverUrl, instanceToken, to, text, replyId } = args
  const response = await fetch(`${serverUrl}/send/text`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: to,
      text,
      linkPreview: true,
      replyid: replyId || '',
      readchat: false,
      delay: 0,
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs extends InstanceTokenArgs {
  to: string
  kind: MediaKind
  /** Public URL uazapi fetches at send time (base64 also accepted by the API but we always pass URLs). */
  link: string
  caption?: string
  /** Document-only file name. */
  filename?: string
  replyId?: string
}

/**
 * Send an image, video, document, or audio (voice note). uazapi's
 * `type` field distinguishes "audio" (file attachment) from "ptt"
 * (voice-note bubble with waveform) — our `audio` kind maps to `ptt`
 * since that's what the inbox composer's voice recorder produces.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<UazapiSendResult> {
  const { serverUrl, instanceToken, to, kind, link, caption, filename, replyId } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')
  const uazapiType = kind === 'audio' ? 'ptt' : kind
  const response = await fetch(`${serverUrl}/send/media`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: to,
      type: uazapiType,
      file: link,
      text: caption || '',
      docName: kind === 'document' ? filename || '' : '',
      replyid: replyId || '',
      readchat: false,
      delay: 0,
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid }
}

export interface SendMenuMessageArgs extends InstanceTokenArgs {
  to: string
  /** uazapi menu flavour. We only emit 'button' and 'list'. */
  type: 'button' | 'list'
  /** Body text of the menu message. */
  text: string
  footerText?: string
  /** Label of the tap-to-expand button — 'list' type only. */
  listButton?: string
  /**
   * uazapi's flat choice encoding:
   *   buttons: "Visible title|id"
   *   list rows: "Visible title|description|id" (description optional),
   *     with a "[Section title]" entry starting a new section.
   */
  choices: string[]
  replyId?: string
}

/**
 * Send an interactive menu (reply buttons or a tappable list) via
 * uazapi's /send/menu. The InteractiveMessagePayload → choices
 * conversion lives in interactive.ts (interactivePayloadToMenu) so
 * every caller emits the same shape.
 */
export async function sendMenuMessage(
  args: SendMenuMessageArgs,
): Promise<UazapiSendResult> {
  const { serverUrl, instanceToken, to, type, text, footerText, listButton, choices, replyId } = args
  const response = await fetch(`${serverUrl}/send/menu`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: to,
      type,
      text,
      footerText: footerText || '',
      listButton: listButton || '',
      selectableCount: 1,
      choices,
      replyid: replyId || '',
      readchat: false,
      delay: 0,
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid }
}

export interface SendReactionArgs extends InstanceTokenArgs {
  to: string
  /** uazapi message id being reacted to. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

export async function sendReactionMessage(
  args: SendReactionArgs,
): Promise<UazapiSendResult> {
  const { serverUrl, instanceToken, to, targetMessageId, emoji } = args
  const response = await fetch(`${serverUrl}/message/react`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: to, text: emoji, id: targetMessageId }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.id ?? data.messageid ?? targetMessageId }
}

export interface DeleteMessageArgs extends InstanceTokenArgs {
  to: string
  /** uazapi message id to delete-for-everyone. */
  targetMessageId: string
}

/**
 * Delete-for-everyone. Endpoint follows the /message/react convention
 * (POST /message/delete, { number, id }) but has not been confirmed
 * against a live uazapiGO server — WhatsApp's own delete window is a
 * few minutes, too destructive to test blind against a real chat.
 * If the path/shape is wrong, uazapi's error message surfaces as-is
 * through throwUazapiError to the route's 502 response.
 */
export async function deleteMessage(
  args: DeleteMessageArgs,
): Promise<void> {
  const { serverUrl, instanceToken, to, targetMessageId } = args
  const response = await fetch(`${serverUrl}/message/delete`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: to, id: targetMessageId }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `uazapi API error: ${response.status}`)
  }
}

// ============================================================
// Media download (inbound)
// ============================================================

export interface DownloadMediaArgs extends InstanceTokenArgs {
  /** uazapi message id (the "id" field from the messages webhook). */
  messageId: string
}

/**
 * Resolve an inbound media message to its downloadable bytes.
 * uazapi returns either a `fileURL` or base64 `file` depending on
 * media size/config — this normalizes to bytes either way.
 */
export async function downloadMedia(
  args: DownloadMediaArgs,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { serverUrl, instanceToken, messageId } = args
  const response = await fetch(`${serverUrl}/message/download`, {
    method: 'POST',
    headers: { token: instanceToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: messageId }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `Media download failed: ${response.status}`)
  }
  const data = await response.json()
  const contentType = data.mimetype || data.mimeType || 'application/octet-stream'

  if (data.fileURL) {
    const fileResponse = await fetch(data.fileURL)
    if (!fileResponse.ok) {
      throw new Error(`Media file fetch failed: ${fileResponse.status}`)
    }
    return {
      buffer: Buffer.from(await fileResponse.arrayBuffer()),
      contentType,
    }
  }
  if (data.file) {
    return { buffer: Buffer.from(data.file, 'base64'), contentType }
  }
  throw new Error('uazapi media download returned neither fileURL nor file (base64).')
}
