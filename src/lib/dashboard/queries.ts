import type { SupabaseClient } from '@supabase/supabase-js'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  AgentPerformanceRow,
  ConversationsSeriesPoint,
  MetricsBundle,
  PendingQueueSummary,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

/** SLA target used to compute "% within target" everywhere below. Kept
 *  in sync with `ResponseTimeChart`'s default `thresholdMinutes` prop —
 *  not yet an account-configurable setting. */
const SLA_TARGET_MINUTES = 5

// ------------------------------------------------------------
// All client-side aggregation. RLS scopes every query to the
// signed-in user automatically, so we never pass user_id explicitly
// here. Perf is acceptable for the current scale (low thousands of
// messages) — if a tenant's dataset outgrows this, we'd migrate the
// heavy aggregations to SQL RPCs. Noted in the PR.
// ------------------------------------------------------------

type DB = SupabaseClient

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDeals,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', todayStart),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('deals').select('value, status').eq('status', 'open'),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', todayStart),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  const openDealsRows = (openDeals.data ?? []) as { value: number | null }[]
  const openDealsValue = openDealsRows.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return {
    activeConversations: {
      current: openConvCur.count ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday.count ?? 0) - (newConvYesterday.count ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday.count ?? 0,
      previous: messagesYesterday.count ?? 0,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('created_at, sender_type')
    .gte('created_at', start)
    .order('created_at', { ascending: true })
  if (error) throw error

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of (data ?? []) as { created_at: string; sender_type: string }[]) {
    const key = localDayKey(row.created_at)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.sender_type === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1 // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    db.from('deals').select('stage_id, value, status').eq('status', 'open'),
  ])

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const deals = (dealsRes.data ?? []) as { stage_id: string; value: number | null }[]

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += d.value ?? 0
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week + per-agent SLA -------------------
//
// Both `loadResponseTime` and `loadAgentPerformance` need the same
// "first customer message → first HUMAN reply" pairing over the same
// 14-day window of messages. `fetchResponseSamples` does the one DB
// round-trip + pairing pass; each public function just aggregates the
// shared samples differently. Bot replies are deliberately excluded
// from every pairing here — a bot answering isn't a human meeting an
// SLA, and counting it would understate real response times and
// misattribute credit away from the humans actually on shift.

interface ResponseSample {
  conversationId: string
  customerAt: Date
  responseAt: Date
  /** Who sent the human reply. Null for legacy rows sent before we
   *  started stamping `sender_id` (see send-message.ts) — those
   *  samples still count toward the aggregate averages but are
   *  excluded from the per-agent breakdown. */
  agentId: string | null
}

async function fetchResponseSamples(db: DB): Promise<ResponseSample[]> {
  // 14 days gives us both "this week" + "last week" with enough
  // overlap if the user opens the dashboard late on a Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, sender_type, sender_id, created_at')
    .gte('created_at', fourteenDaysAgo)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as {
    conversation_id: string
    sender_type: string
    sender_id: string | null
    created_at: string
  }[]

  // Walk per conversation, pairing each unreplied customer message
  // with the next HUMAN outbound message. Bot messages are skipped —
  // they neither close out a pending customer message nor count as a
  // response — so a bot reply followed later by a human reply still
  // measures the human's real response time. A single customer
  // message can only count once (avoids inflating averages if the
  // customer double-messages while the agent takes time to reply).
  const samples: ResponseSample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (row.sender_type === 'agent' && pendingCustomer) {
      samples.push({
        conversationId: row.conversation_id,
        customerAt: pendingCustomer,
        responseAt: ts,
        agentId: row.sender_id,
      })
      pendingCustomer = null
    }
    // sender_type === 'bot': neither clears nor consumes pendingCustomer.
  }

  return samples.filter((s) => s.responseAt.getTime() >= s.customerAt.getTime())
}

function avg(arr: number[]): number | null {
  return arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length
}

function pctWithin(arr: number[], targetMinutes: number): number | null {
  if (arr.length === 0) return null
  const within = arr.filter((m) => m <= targetMinutes).length
  return (within / arr.length) * 100
}

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  const samples = await fetchResponseSamples(db)

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []
  const allMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    allMins.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const bucketSamples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(bucketSamples),
      samples: bucketSamples.length,
    }
  })

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
    pctWithinTarget: pctWithin(allMins, SLA_TARGET_MINUTES),
    sampleCount: allMins.length,
  }
}

// --- 4b. Per-agent volume + SLA (admin/owner only in the UI) -----------

export async function loadAgentPerformance(db: DB): Promise<AgentPerformanceRow[]> {
  const samples = await fetchResponseSamples(db)

  const byAgent = new Map<
    string,
    { conversations: Set<string>; minutes: number[] }
  >()
  for (const s of samples) {
    if (!s.agentId) continue // legacy row with no sender_id — can't attribute
    const entry = byAgent.get(s.agentId) ?? { conversations: new Set(), minutes: [] }
    entry.conversations.add(s.conversationId)
    entry.minutes.push((s.responseAt.getTime() - s.customerAt.getTime()) / 60_000)
    byAgent.set(s.agentId, entry)
  }

  // Message counts are a separate, simpler tally — every agent message
  // in the window counts, not just ones that happened to pair with a
  // pending customer message (a busy agent sends plenty of follow-ups
  // that aren't "first responses").
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const { data: msgCountRows, error: msgCountErr } = await db
    .from('messages')
    .select('sender_id')
    .eq('sender_type', 'agent')
    .not('sender_id', 'is', null)
    .gte('created_at', fourteenDaysAgo)
  if (msgCountErr) throw msgCountErr

  const messageCounts = new Map<string, number>()
  for (const row of (msgCountRows ?? []) as { sender_id: string }[]) {
    messageCounts.set(row.sender_id, (messageCounts.get(row.sender_id) ?? 0) + 1)
  }

  const agentIds = new Set([...byAgent.keys(), ...messageCounts.keys()])
  if (agentIds.size === 0) return []

  const { data: profileRows, error: profileErr } = await db
    .from('profiles')
    .select('user_id, full_name, avatar_url')
    .in('user_id', [...agentIds])
  if (profileErr) throw profileErr

  const profileById = new Map(
    ((profileRows ?? []) as { user_id: string; full_name: string | null; avatar_url: string | null }[]).map(
      (p) => [p.user_id, p],
    ),
  )

  const rows: AgentPerformanceRow[] = [...agentIds].map((agentId) => {
    const perf = byAgent.get(agentId)
    const profile = profileById.get(agentId)
    return {
      agentId,
      name: profile?.full_name || 'Unknown',
      avatarUrl: profile?.avatar_url ?? null,
      conversationCount: perf?.conversations.size ?? 0,
      messageCount: messageCounts.get(agentId) ?? 0,
      avgResponseMinutes: perf ? avg(perf.minutes) : null,
      pctWithinTarget: perf ? pctWithin(perf.minutes, SLA_TARGET_MINUTES) : null,
      sampleCount: perf?.minutes.length ?? 0,
    }
  })

  return rows.sort((a, b) => b.messageCount - a.messageCount)
}

// --- 4c. Pending queue — conversations awaiting a human reply ----------

export async function loadPendingQueue(db: DB): Promise<PendingQueueSummary> {
  // The last message per open/pending conversation tells us whether
  // it's awaiting a reply. `status` alone isn't reliable — an "open"
  // conversation may already have been answered and just not closed —
  // so we look at who sent the most recent message instead.
  //
  // The nested `messages(...)` select is capped to 1 row per
  // conversation (ordered newest-first) via PostgREST's per-embed
  // order/limit modifiers, so this stays cheap regardless of how long
  // a conversation's history is.
  const { data, error } = await db
    .from('conversations')
    .select('id, messages(sender_type, created_at)')
    .in('status', ['open', 'pending'])
    .order('created_at', { foreignTable: 'messages', ascending: false })
    .limit(1, { foreignTable: 'messages' })
  if (error) throw error

  type Row = {
    id: string
    messages: { sender_type: string; created_at: string }[]
  }

  let count = 0
  let oldest: Date | null = null

  for (const conv of (data ?? []) as Row[]) {
    const last = conv.messages[0]
    if (!last || last.sender_type !== 'customer') continue
    count += 1
    const at = new Date(last.created_at)
    if (!oldest || at < oldest) oldest = at
  }

  return {
    count,
    oldestWaitMinutes: oldest ? (Date.now() - oldest.getTime()) / 60_000 : null,
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []

  // PostgREST returns nested selections as arrays by default, even when
  // the foreign key is 1:1. We normalise by taking [0] on each level.
  for (const m of (msgs.data ?? []) as unknown as Array<{
    id: string
    content_text: string | null
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
    const who = contact?.name || contact?.phone || 'Unknown'
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `New message from ${who}`,
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? `Deal "${d.title}" in ${stage.name}`
        : `Deal "${d.title}" updated`,
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || 'a contact'
    const autoName = automation?.name || 'Automation'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automation "${autoName}" ${l.status === 'failed' ? 'failed for' : 'triggered for'} ${who}`,
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}
