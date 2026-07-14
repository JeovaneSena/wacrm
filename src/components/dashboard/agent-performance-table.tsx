'use client'

import { Users } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import type { AgentPerformanceRow } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface AgentPerformanceTableProps {
  data: AgentPerformanceRow[] | null
  loading: boolean
}

/** Admin/owner-only widget — the RBAC gate lives in the page, not here. */
export function AgentPerformanceTable({ data, loading }: AgentPerformanceTableProps) {
  const t = useTranslations('Dashboard.agentPerformance')
  const hasData = (data?.length ?? 0) > 0

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-[200px] w-full" />
        ) : !hasData ? (
          <EmptyState icon={Users} title={t('empty')} hint={t('emptyHint')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">{t('colAgent')}</th>
                  <th className="pb-2 pl-4 font-medium tabular-nums">{t('colConversations')}</th>
                  <th className="pb-2 pl-4 font-medium tabular-nums">{t('colMessages')}</th>
                  <th className="pb-2 pl-4 font-medium tabular-nums">{t('colAvgResponse')}</th>
                  <th className="pb-2 pl-4 font-medium tabular-nums">{t('colWithinTarget')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.map((row) => (
                  <tr key={row.agentId}>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar className="size-7 shrink-0">
                          {row.avatarUrl ? <AvatarImage src={row.avatarUrl} alt={row.name} /> : null}
                          <AvatarFallback className="bg-primary/10 text-[11px] font-medium text-primary">
                            {row.name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate font-medium text-foreground">{row.name}</span>
                      </div>
                    </td>
                    <td className="py-2.5 pl-4 tabular-nums text-foreground">
                      {row.conversationCount.toLocaleString()}
                    </td>
                    <td className="py-2.5 pl-4 tabular-nums text-foreground">
                      {row.messageCount.toLocaleString()}
                    </td>
                    <td className="py-2.5 pl-4 tabular-nums text-foreground">
                      {fmtMinutes(row.avgResponseMinutes)}
                    </td>
                    <td className="py-2.5 pl-4 tabular-nums">
                      {row.pctWithinTarget == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={
                            row.pctWithinTarget >= 80
                              ? 'text-emerald-400'
                              : row.pctWithinTarget >= 50
                                ? 'text-amber-400'
                                : 'text-rose-400'
                          }
                        >
                          {row.pctWithinTarget.toFixed(0)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function fmtMinutes(mins: number | null): string {
  if (mins == null) return '—'
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`
  if (mins < 60) return `${mins.toFixed(1)}m`
  return `${(mins / 60).toFixed(1)}h`
}
