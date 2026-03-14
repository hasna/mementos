import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { Memory, MemoryScope, MemoryCategory } from "@/types";

const API_BASE = "/api";

interface MemoryEditDialogProps {
  memory: Memory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function MemoryEditDialog({ memory, open, onOpenChange, onSaved }: MemoryEditDialogProps) {
  const [value, setValue] = React.useState("");
  const [importance, setImportance] = React.useState(5);
  const [tags, setTags] = React.useState("");
  const [scope, setScope] = React.useState<MemoryScope>("shared");
  const [category, setCategory] = React.useState<MemoryCategory>("knowledge");
  const [pinned, setPinned] = React.useState(false);
  const [summary, setSummary] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Populate form when memory changes
  React.useEffect(() => {
    if (memory) {
      setValue(memory.value);
      setImportance(memory.importance);
      setTags(memory.tags.join(", "));
      setScope(memory.scope);
      setCategory(memory.category);
      setPinned(memory.pinned);
      setSummary(memory.summary || "");
      setError(null);
    }
  }, [memory]);

  async function handleSave() {
    if (!memory) return;
    setSaving(true);
    setError(null);

    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const res = await fetch(`${API_BASE}/memories/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value,
          importance,
          tags: parsedTags,
          scope,
          category,
          pinned,
          summary: summary || null,
          version: memory.version,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setError(
            "Version conflict: this memory was modified by another session. Close and reopen to get the latest version."
          );
        } else {
          setError(body.error || `Failed to save (${res.status})`);
        }
        return;
      }

      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Memory</DialogTitle>
          <DialogDescription>
            {memory ? (
              <>
                <span className="font-mono text-xs">{memory.key}</span>
                <span className="ml-2 text-xs text-muted-foreground">v{memory.version}</span>
              </>
            ) : (
              "Edit memory fields"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Value */}
          <div className="grid gap-2">
            <Label htmlFor="edit-value">Value</Label>
            <Textarea
              id="edit-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={6}
              className="font-mono text-sm"
            />
          </div>

          {/* Summary */}
          <div className="grid gap-2">
            <Label htmlFor="edit-summary">Summary</Label>
            <Input
              id="edit-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Optional short summary"
            />
          </div>

          {/* Scope + Category row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as MemoryScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as MemoryCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preference">Preference</SelectItem>
                  <SelectItem value="fact">Fact</SelectItem>
                  <SelectItem value="knowledge">Knowledge</SelectItem>
                  <SelectItem value="history">History</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Importance + Tags row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-importance">Importance (1-10)</Label>
              <Input
                id="edit-importance"
                type="number"
                min={1}
                max={10}
                value={importance}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1 && v <= 10) setImportance(v);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-tags">Tags (comma-separated)</Label>
              <Input
                id="edit-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tag1, tag2, tag3"
              />
            </div>
          </div>

          {/* Pinned */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="edit-pinned"
              checked={pinned}
              onCheckedChange={(checked) => setPinned(checked === true)}
            />
            <Label htmlFor="edit-pinned" className="cursor-pointer">
              Pinned
            </Label>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
