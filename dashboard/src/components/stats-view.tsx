import {
  BrainIcon,
  GlobeIcon,
  UsersIcon,
  LockIcon,
  BookOpenIcon,
  LightbulbIcon,
  StarIcon,
  ClockIcon,
  PinIcon,
  ArchiveIcon,
  BotIcon,
  FolderIcon,
  ActivityIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MemoryStats } from "@/types";

interface StatsViewProps {
  stats: MemoryStats;
  agentCount: number;
  projectCount: number;
}

export function StatsView({ stats, agentCount, projectCount }: StatsViewProps) {
  const topCards = [
    { label: "Total Memories", value: stats.total, icon: BrainIcon, color: "text-foreground" },
    { label: "Pinned", value: stats.pinned_count, icon: PinIcon, color: "text-amber-500" },
    { label: "Expired", value: stats.expired_count, icon: ClockIcon, color: "text-red-500" },
    { label: "Agents", value: agentCount, icon: BotIcon, color: "text-orange-500" },
    { label: "Projects", value: projectCount, icon: FolderIcon, color: "text-purple-500" },
  ];

  const scopeCards = [
    { label: "Global", value: stats.by_scope.global, icon: GlobeIcon, color: "text-teal-500", bg: "bg-teal-500/10" },
    { label: "Shared", value: stats.by_scope.shared, icon: UsersIcon, color: "text-amber-500", bg: "bg-amber-500/10" },
    { label: "Private", value: stats.by_scope.private, icon: LockIcon, color: "text-purple-500", bg: "bg-purple-500/10" },
  ];

  const categoryCards = [
    { label: "Preference", value: stats.by_category.preference, icon: StarIcon, color: "text-blue-500", bg: "bg-blue-500/10" },
    { label: "Fact", value: stats.by_category.fact, icon: BookOpenIcon, color: "text-green-500", bg: "bg-green-500/10" },
    { label: "Knowledge", value: stats.by_category.knowledge, icon: LightbulbIcon, color: "text-yellow-500", bg: "bg-yellow-500/10" },
    { label: "History", value: stats.by_category.history, icon: ClockIcon, color: "text-gray-400", bg: "bg-gray-500/10" },
  ];

  const statusCards = [
    { label: "Active", value: stats.by_status.active, color: "text-green-500" },
    { label: "Archived", value: stats.by_status.archived, color: "text-gray-400" },
    { label: "Expired", value: stats.by_status.expired, color: "text-red-500" },
  ];

  const agentEntries = Object.entries(stats.by_agent);

  return (
    <div className="space-y-6">
      {/* Top-level stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {topCards.map((c) => (
          <Card key={c.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 p-4">
              <CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle>
              <c.icon className={`size-4 ${c.color}`} />
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="text-2xl font-bold">{c.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* By Scope */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <GlobeIcon className="size-4 text-teal-500" /> By Scope
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {scopeCards.map((s) => {
                const pct = stats.total > 0 ? Math.round((s.value / stats.total) * 100) : 0;
                return (
                  <div key={s.label} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <s.icon className={`size-3.5 ${s.color}`} />
                        <span>{s.label}</span>
                      </div>
                      <span className="font-medium">{s.value} <span className="text-muted-foreground font-normal">({pct}%)</span></span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full ${s.bg} ${s.color.replace("text-", "bg-")}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* By Category */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <ActivityIcon className="size-4 text-blue-500" /> By Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {categoryCards.map((c) => {
                const pct = stats.total > 0 ? Math.round((c.value / stats.total) * 100) : 0;
                return (
                  <div key={c.label} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <c.icon className={`size-3.5 ${c.color}`} />
                        <span>{c.label}</span>
                      </div>
                      <span className="font-medium">{c.value} <span className="text-muted-foreground font-normal">({pct}%)</span></span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full ${c.color.replace("text-", "bg-")}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* By Status */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <ArchiveIcon className="size-4 text-muted-foreground" /> By Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3 text-center">
              {statusCards.map((s) => (
                <div key={s.label} className="rounded-lg border p-3">
                  <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-sm text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* By Agent */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <BotIcon className="size-4 text-orange-500" /> Memories by Agent
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agentEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent-specific memories.</p>
            ) : (
              <div className="space-y-2">
                {agentEntries.map(([agentId, count]) => (
                  <div key={agentId} className="flex items-center justify-between text-sm">
                    <code className="text-muted-foreground">{agentId}</code>
                    <span className="font-medium">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
