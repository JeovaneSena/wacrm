// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
  /** % of human-response samples (last 14 days) at/under the SLA target. Null if no samples. */
  pctWithinTarget: number | null
  /** Total human-response samples the summary (and pctWithinTarget) is based on. */
  sampleCount: number
}

export interface AgentPerformanceRow {
  agentId: string
  name: string
  avatarUrl: string | null
  /** Distinct conversations this agent sent at least one message in (last 14 days). */
  conversationCount: number
  /** Total messages this agent sent (last 14 days). */
  messageCount: number
  /** Average first-response time in minutes, this agent's replies only. Null if no samples. */
  avgResponseMinutes: number | null
  /** % of this agent's first-response samples at/under the SLA target. Null if no samples. */
  pctWithinTarget: number | null
  sampleCount: number
}

export interface PendingQueueSummary {
  /** Conversations whose most recent message is from the customer (awaiting a reply). */
  count: number
  /** Minutes since the oldest awaiting-reply conversation's last customer message. Null if count is 0. */
  oldestWaitMinutes: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
