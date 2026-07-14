// ============================================================
// Interactive message payload — shared shape + validation.
//
// The persisted, round-trippable representation of a WhatsApp
// interactive message (reply buttons or a list). This is the single
// source of truth used by:
//   - the inbox composer + automation "send interactive" builders,
//   - the send-message core + automation engine (send + persist),
//   - the message bubble + preview (render),
//   - quick replies (store an interactive snippet).
//
// The field names (`id`/`title`/`description` on buttons/rows) match
// `meta-api.ts`'s `InteractiveButton` / `InteractiveListRow` /
// `InteractiveListSection` on purpose, so a payload maps straight onto
// the Meta send args with no translation.
//
// `validateInteractivePayload` mirrors the throws already inside the
// meta-api senders, but returns a result object so callers (API routes,
// activation checks) can surface a clean error to the user *before* the
// network call rather than turning a bad payload into a 400 from Meta
// mid-conversation.
// ============================================================

/**
 * Hard limits for interactive messages, enforced at build/save time so
 * violations fail as a developer-facing error rather than a customer-
 * facing one. Inherited from WhatsApp's own UI constraints (3 buttons,
 * 10 list rows, title lengths) — they still apply over uazapi since
 * the rendering happens in the same WhatsApp client.
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface InteractiveButton {
  /** Stable id echoed back in the webhook when tapped. */
  id: string
  /** Visible label (≤ 20 chars per Meta). */
  title: string
}

export interface InteractiveButtonsPayload {
  kind: 'buttons'
  /** Body text shown above the buttons (≤ 1024 chars). */
  body: string
  /** Optional plain-text header (≤ 60 chars). */
  header?: string
  /** Optional grey footer line (≤ 60 chars). */
  footer?: string
  /** 1–3 buttons. */
  buttons: InteractiveButton[]
}

export interface InteractiveListRow {
  /** Stable id echoed back in the webhook when selected. */
  id: string
  /** Row title (≤ 24 chars per Meta). */
  title: string
  /** Optional secondary line (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface InteractiveListPayload {
  kind: 'list'
  body: string
  header?: string
  footer?: string
  /** Label of the tap-to-expand button on the message bubble (≤ 20 chars). */
  button_label: string
  /** 1–10 rows TOTAL across all sections. */
  sections: InteractiveListSection[]
}

export type InteractiveMessagePayload =
  | InteractiveButtonsPayload
  | InteractiveListPayload

export type InteractiveValidation =
  | { ok: true }
  | { ok: false; error: string }

function ok(): InteractiveValidation {
  return { ok: true }
}
function fail(error: string): InteractiveValidation {
  return { ok: false, error }
}

function validateHeaderFooter(
  header: string | undefined,
  footer: string | undefined,
): InteractiveValidation {
  if (header && header.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    return fail(
      `Header exceeds the ${INTERACTIVE_LIMITS.headerTextMaxLength}-character limit.`,
    )
  }
  if (footer && footer.length > INTERACTIVE_LIMITS.footerMaxLength) {
    return fail(
      `Footer exceeds the ${INTERACTIVE_LIMITS.footerMaxLength}-character limit.`,
    )
  }
  return ok()
}

/**
 * Validate an interactive payload against Meta's hard limits + our
 * structural rules (non-empty ids/titles, unique ids). Returns a result
 * object rather than throwing so API routes can map it to a 400 with a
 * user-facing message.
 *
 * `unknown` in, narrowed here, so it's safe to call straight on a parsed
 * request body.
 */
export function validateInteractivePayload(
  payload: unknown,
): InteractiveValidation {
  if (!payload || typeof payload !== 'object') {
    return fail('Interactive message payload is required.')
  }
  const p = payload as Partial<InteractiveMessagePayload>

  if (typeof p.body !== 'string' || p.body.trim() === '') {
    return fail('Interactive message body text is required.')
  }
  if (p.body.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    return fail(
      `Body text exceeds the ${INTERACTIVE_LIMITS.bodyMaxLength}-character limit.`,
    )
  }
  const hf = validateHeaderFooter(p.header, p.footer)
  if (!hf.ok) return hf

  if (p.kind === 'buttons') {
    const buttons = (p as InteractiveButtonsPayload).buttons
    if (!Array.isArray(buttons) || buttons.length < 1) {
      return fail('Add at least one reply button.')
    }
    if (buttons.length > INTERACTIVE_LIMITS.maxButtons) {
      return fail(
        `A reply-button message allows at most ${INTERACTIVE_LIMITS.maxButtons} buttons.`,
      )
    }
    const seen = new Set<string>()
    for (const b of buttons) {
      if (!b || typeof b.id !== 'string' || b.id.trim() === '') {
        return fail('Every button needs an id.')
      }
      if (seen.has(b.id)) {
        return fail(`Duplicate button id "${b.id}".`)
      }
      seen.add(b.id)
      if (typeof b.title !== 'string' || b.title.trim() === '') {
        return fail('Every button needs a label.')
      }
      if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
        return fail(
          `Button label "${b.title}" exceeds the ${INTERACTIVE_LIMITS.buttonTitleMaxLength}-character limit.`,
        )
      }
    }
    return ok()
  }

  if (p.kind === 'list') {
    const list = p as InteractiveListPayload
    if (
      typeof list.button_label !== 'string' ||
      list.button_label.trim() === ''
    ) {
      return fail('The list needs a button label.')
    }
    if (list.button_label.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      return fail(
        `List button label exceeds the ${INTERACTIVE_LIMITS.buttonTitleMaxLength}-character limit.`,
      )
    }
    if (!Array.isArray(list.sections) || list.sections.length < 1) {
      return fail('Add at least one list section.')
    }
    if (list.sections.length > INTERACTIVE_LIMITS.maxListSections) {
      return fail(
        `A list allows at most ${INTERACTIVE_LIMITS.maxListSections} sections.`,
      )
    }
    const seen = new Set<string>()
    let total = 0
    for (const section of list.sections) {
      if (!section || !Array.isArray(section.rows)) {
        return fail('Every list section needs rows.')
      }
      for (const row of section.rows) {
        total++
        if (!row || typeof row.id !== 'string' || row.id.trim() === '') {
          return fail('Every list row needs an id.')
        }
        if (seen.has(row.id)) {
          return fail(`Duplicate list row id "${row.id}".`)
        }
        seen.add(row.id)
        if (typeof row.title !== 'string' || row.title.trim() === '') {
          return fail('Every list row needs a title.')
        }
        if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
          return fail(
            `List row title "${row.title}" exceeds the ${INTERACTIVE_LIMITS.listRowTitleMaxLength}-character limit.`,
          )
        }
        if (
          row.description &&
          row.description.length >
            INTERACTIVE_LIMITS.listRowDescriptionMaxLength
        ) {
          return fail(
            `List row description exceeds the ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength}-character limit.`,
          )
        }
      }
    }
    if (total < 1) return fail('Add at least one list row.')
    if (total > INTERACTIVE_LIMITS.maxListRowsTotal) {
      return fail(
        `A list allows at most ${INTERACTIVE_LIMITS.maxListRowsTotal} rows in total.`,
      )
    }
    return ok()
  }

  return fail('Interactive message must be reply buttons or a list.')
}

export interface UazapiMenuShape {
  type: 'button' | 'list'
  text: string
  footerText?: string
  listButton?: string
  choices: string[]
}

/**
 * Convert an InteractiveMessagePayload into uazapi's /send/menu shape.
 *
 * uazapi's menu has no separate header field, so a header is folded
 * into the body as a leading bold line (WhatsApp renders *text* bold).
 * Choice encoding (confirmed against uazapi's Postman collection):
 *   buttons:   "Title|id"
 *   list rows: "Title|description|id" (or "Title|id" without one),
 *   sections:  a "[Section title]" entry opens a new section.
 */
export function interactivePayloadToMenu(
  payload: InteractiveMessagePayload,
): UazapiMenuShape {
  const text = payload.header
    ? `*${payload.header}*\n\n${payload.body}`
    : payload.body

  if (payload.kind === 'buttons') {
    return {
      type: 'button',
      text,
      footerText: payload.footer,
      choices: payload.buttons.map((b) => `${b.title}|${b.id}`),
    }
  }

  const choices: string[] = []
  for (const section of payload.sections) {
    if (section.title) choices.push(`[${section.title}]`)
    for (const row of section.rows) {
      choices.push(
        row.description
          ? `${row.title}|${row.description}|${row.id}`
          : `${row.title}|${row.id}`,
      )
    }
  }
  return {
    type: 'list',
    text,
    footerText: payload.footer,
    listButton: payload.button_label,
    choices,
  }
}

/**
 * Short single-line summary used for `conversations.last_message_text`
 * and quick-reply list rows — the body, trimmed, or a sensible fallback.
 */
export function interactivePayloadPreviewText(
  payload: InteractiveMessagePayload,
): string {
  const body = payload.body?.trim()
  if (body) return body
  return payload.kind === 'buttons' ? '[buttons]' : '[list]'
}
