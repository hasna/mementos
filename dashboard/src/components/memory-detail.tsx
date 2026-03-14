import { ArrowLeftIcon, PinIcon, ClockIcon, TagIcon, BrainIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Memory } from "@/types";

function timeAgo(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function scopeBadgeClass(scope: string): string {
  const map: Record<string, string> = {
    global: "bg-teal-500/15 text-teal-400 border-teal-500/30",
    shared: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    private: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  };
  return map[scope] || "";
}

function categoryBadgeClass(category: string): string {
  const map: Record<string, string> = {
    preference: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    fact: "bg-green-500/15 text-green-400 border-green-500/30",
    knowledge: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    history: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  };
  return map[category] || "";
}

function importanceColor(importance: number): string {
  if (importance >= 8) return "text-red-500";
  if (importance >= 5) return "text-yellow-500";
  return "text-gray-400";
}

function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-xs">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal">$2</li>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-blue-400 underline" target="_blank">$1</a>')
    .replace(/\n/g, "<br />");
}

interface MemoryDetailProps {
  memory: Memory;
  onBack: () => void;
  onEdit?: (memory: Memory) => void;
  onDelete?: (memory: Memory) => void;
}

export function MemoryDetail({ memory, onBack, onEdit, onDelete }: MemoryDetailProps) {
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 -ml-2">
        <ArrowLeftIcon className="size-3.5" /> Back to memories
      </Button>

      <Card className="shadow-none">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <CardTitle className="text-lg flex items-center gap-2">
                <BrainIcon className="size-5 text-purple-500" />
                {memory.key}
                {memory.pinned && <PinIcon className="size-4 text-amber-500" />}
              </CardTitle>
              <div className="flex items-center gap-2 mt-2">
                <Badge className={scopeBadgeClass(memory.scope)}>{memory.scope}</Badge>
                <Badge className={categoryBadgeClass(memory.category)}>{memory.category}</Badge>
                <Badge variant="outline" className={importanceColor(memory.importance)}>
                  importance: {memory.importance}
                </Badge>
                <Badge variant="outline">{memory.source}</Badge>
                <Badge variant="outline">{memory.status}</Badge>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {onEdit && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onEdit(memory)}>
                  <PencilIcon className="size-3.5" /> Edit
                </Button>
              )}
              {onDelete && (
                <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:bg-destructive/10" onClick={() => onDelete(memory)}>
                  <Trash2Icon className="size-3.5" /> Delete
                </Button>
              )}
              <code className="text-xs text-muted-foreground">{memory.id}</code>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Value */}
          <div>
            <h3 className="text-sm font-medium mb-2">Value</h3>
            <div
              className="rounded-lg border bg-muted/30 p-4 text-sm break-words prose prose-invert prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(memory.value) }}
            />
          </div>

          {/* Summary */}
          {memory.summary && (
            <div>
              <h3 className="text-sm font-medium mb-2">Summary</h3>
              <p className="text-sm text-muted-foreground">{memory.summary}</p>
            </div>
          )}

          {/* Tags */}
          {memory.tags.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <TagIcon className="size-3.5" /> Tags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {memory.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <h3 className="font-medium mb-2">Details</h3>
              <dl className="space-y-1.5 text-muted-foreground">
                <div className="flex justify-between">
                  <dt>Agent ID</dt>
                  <dd className="text-foreground">{memory.agent_id || "\u2014"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Project ID</dt>
                  <dd className="text-foreground">{memory.project_id || "\u2014"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Session ID</dt>
                  <dd className="text-foreground">{memory.session_id || "\u2014"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Version</dt>
                  <dd className="text-foreground">{memory.version}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Access Count</dt>
                  <dd className="text-foreground">{memory.access_count}</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3 className="font-medium mb-2 flex items-center gap-1.5">
                <ClockIcon className="size-3.5" /> Timestamps
              </h3>
              <dl className="space-y-1.5 text-muted-foreground">
                <div className="flex justify-between">
                  <dt>Created</dt>
                  <dd className="text-foreground">{timeAgo(memory.created_at)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Updated</dt>
                  <dd className="text-foreground">{timeAgo(memory.updated_at)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Accessed</dt>
                  <dd className="text-foreground">{memory.accessed_at ? timeAgo(memory.accessed_at) : "\u2014"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Expires</dt>
                  <dd className="text-foreground">{memory.expires_at || "\u2014"}</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Metadata JSON */}
          {Object.keys(memory.metadata).length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2">Metadata</h3>
              <pre className="rounded-lg border bg-muted/30 p-4 text-xs overflow-x-auto">
                {JSON.stringify(memory.metadata, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
