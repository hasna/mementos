import * as React from "react";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PinIcon,
  TagIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { SearchBar } from "@/components/search-bar";
import { MemoryDetail } from "@/components/memory-detail";
import { MemoryEditDialog } from "@/components/memory-edit-dialog";
import { MemoryDeleteDialog } from "@/components/memory-delete-dialog";
import type { Memory, MemoryScope, MemoryCategory } from "@/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// ── Column definitions ───────────────────────────────────────────────────────

function makeColumns(
  onEdit: (memory: Memory) => void,
  onDelete: (memory: Memory) => void,
): ColumnDef<Memory>[] {
  return [
    {
      accessorKey: "key",
      header: ({ column }) => (
        <Button variant="ghost" size="sm" className="-ml-3" onClick={() => column.toggleSorting()}>
          Key <ArrowUpDownIcon className="size-3" />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm truncate max-w-[200px]">{row.original.key}</span>
          {row.original.pinned && <PinIcon className="size-3 text-amber-500 shrink-0" />}
        </div>
      ),
    },
    {
      accessorKey: "value",
      header: "Value",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground truncate max-w-[250px] block">
          {truncate(row.original.value, 80)}
        </span>
      ),
      enableSorting: false,
    },
    {
      accessorKey: "scope",
      header: "Scope",
      cell: ({ row }) => (
        <Badge className={`text-xs ${scopeBadgeClass(row.original.scope)}`}>
          {row.original.scope}
        </Badge>
      ),
      filterFn: (row, _id, value) => !value || value === "all" || row.original.scope === value,
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ row }) => (
        <Badge className={`text-xs ${categoryBadgeClass(row.original.category)}`}>
          {row.original.category}
        </Badge>
      ),
      filterFn: (row, _id, value) => !value || value === "all" || row.original.category === value,
    },
    {
      accessorKey: "importance",
      header: ({ column }) => (
        <Button variant="ghost" size="sm" className="-ml-3" onClick={() => column.toggleSorting()}>
          Imp. <ArrowUpDownIcon className="size-3" />
        </Button>
      ),
      cell: ({ row }) => (
        <span className={`text-sm font-mono font-bold ${importanceColor(row.original.importance)}`}>
          {row.original.importance}
        </span>
      ),
      filterFn: (row, _id, value) => {
        if (!value || value === "all") return true;
        const imp = row.original.importance;
        if (value === "high") return imp >= 8;
        if (value === "medium") return imp >= 5 && imp <= 7;
        if (value === "low") return imp <= 4;
        return true;
      },
    },
    {
      accessorKey: "tags",
      header: "Tags",
      cell: ({ row }) =>
        row.original.tags.length > 0 ? (
          <div className="flex items-center gap-1">
            <TagIcon className="size-3 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate max-w-[120px]">
              {row.original.tags.join(", ")}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{"\u2014"}</span>
        ),
      enableSorting: false,
    },
    {
      accessorKey: "created_at",
      header: ({ column }) => (
        <Button variant="ghost" size="sm" className="-ml-3" onClick={() => column.toggleSorting()}>
          Created <ArrowUpDownIcon className="size-3" />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground whitespace-nowrap">{timeAgo(row.original.created_at)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title="Edit memory"
            onClick={() => onEdit(row.original)}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            title="Delete memory"
            onClick={() => onDelete(row.original)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ),
      enableSorting: false,
    },
  ];
}

// ── Memory Table ─────────────────────────────────────────────────────────────

interface MemoryTableProps {
  data: Memory[];
  onRefresh?: () => void;
}

export function MemoryTable({ data, onRefresh }: MemoryTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "created_at", desc: true }]);
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [scopeFilter, setScopeFilter] = React.useState<string>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [importanceFilter, setImportanceFilter] = React.useState<string>("all");
  const [pinnedFilter, setPinnedFilter] = React.useState(false);
  const [selectedMemory, setSelectedMemory] = React.useState<Memory | null>(null);
  const [editMemory, setEditMemory] = React.useState<Memory | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteMemory, setDeleteMemory] = React.useState<Memory | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleEdit = React.useCallback((memory: Memory) => {
    setEditMemory(memory);
    setEditOpen(true);
  }, []);

  const handleDelete = React.useCallback((memory: Memory) => {
    setDeleteMemory(memory);
    setDeleteOpen(true);
  }, []);

  const handleSaved = React.useCallback(() => {
    setStatusMessage({ type: "success", text: "Memory updated successfully." });
    setTimeout(() => setStatusMessage(null), 3000);
    // If we're viewing the detail of the edited memory, go back to list
    if (selectedMemory && editMemory && selectedMemory.id === editMemory.id) {
      setSelectedMemory(null);
    }
    onRefresh?.();
  }, [selectedMemory, editMemory, onRefresh]);

  const handleDeleted = React.useCallback(() => {
    setStatusMessage({ type: "success", text: "Memory deleted successfully." });
    setTimeout(() => setStatusMessage(null), 3000);
    // If we're viewing the detail of the deleted memory, go back to list
    if (selectedMemory && deleteMemory && selectedMemory.id === deleteMemory.id) {
      setSelectedMemory(null);
    }
    onRefresh?.();
  }, [selectedMemory, deleteMemory, onRefresh]);

  const columns = React.useMemo(() => makeColumns(handleEdit, handleDelete), [handleEdit, handleDelete]);

  const filteredData = React.useMemo(() => {
    let d = data;
    if (scopeFilter && scopeFilter !== "all") {
      d = d.filter((m) => m.scope === scopeFilter);
    }
    if (categoryFilter && categoryFilter !== "all") {
      d = d.filter((m) => m.category === categoryFilter);
    }
    if (importanceFilter && importanceFilter !== "all") {
      d = d.filter((m) => {
        if (importanceFilter === "high") return m.importance >= 8;
        if (importanceFilter === "medium") return m.importance >= 5 && m.importance <= 7;
        if (importanceFilter === "low") return m.importance <= 4;
        return true;
      });
    }
    if (pinnedFilter) {
      d = d.filter((m) => m.pinned);
    }
    return d;
  }, [data, scopeFilter, categoryFilter, importanceFilter, pinnedFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    initialState: { pagination: { pageSize: 20 } },
  });

  if (selectedMemory) {
    return (
      <>
        <MemoryDetail
          memory={selectedMemory}
          onBack={() => setSelectedMemory(null)}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
        <MemoryEditDialog memory={editMemory} open={editOpen} onOpenChange={setEditOpen} onSaved={handleSaved} />
        <MemoryDeleteDialog memory={deleteMemory} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={handleDeleted} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBar
          value={globalFilter}
          onChange={setGlobalFilter}
          placeholder="Search memories... (press /)"
        />

        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scopes</SelectItem>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="shared">Shared</SelectItem>
            <SelectItem value="private">Private</SelectItem>
          </SelectContent>
        </Select>

        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="preference">Preference</SelectItem>
            <SelectItem value="fact">Fact</SelectItem>
            <SelectItem value="knowledge">Knowledge</SelectItem>
            <SelectItem value="history">History</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={pinnedFilter ? "default" : "outline"}
          size="sm"
          className={`h-9 gap-1.5 ${pinnedFilter ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}`}
          onClick={() => setPinnedFilter(!pinnedFilter)}
        >
          <PinIcon className="size-3.5" />
          Pinned
        </Button>

        <Select value={importanceFilter} onValueChange={setImportanceFilter}>
          <SelectTrigger className="w-[150px] h-9">
            <SelectValue placeholder="Importance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Importance</SelectItem>
            <SelectItem value="high">High (8-10)</SelectItem>
            <SelectItem value="medium">Medium (5-7)</SelectItem>
            <SelectItem value="low">Low (1-4)</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground ml-auto">
          {table.getFilteredRowModel().rows.length} memor{table.getFilteredRowModel().rows.length === 1 ? "y" : "ies"}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={`cursor-pointer ${row.original.pinned ? "border-l-2 border-l-amber-500 bg-amber-500/5" : ""}`}
                  onClick={() => setSelectedMemory(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No memories found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {table.getFilteredRowModel().rows.length} memor{table.getFilteredRowModel().rows.length === 1 ? "y" : "ies"}
        </p>
        {table.getPageCount() > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
              <ChevronLeftIcon className="size-3.5" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
              <ChevronRightIcon className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Status message */}
      {statusMessage && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            statusMessage.type === "success"
              ? "border-green-500/30 bg-green-500/10 text-green-500"
              : "border-destructive/50 bg-destructive/10 text-destructive"
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Edit / Delete dialogs */}
      <MemoryEditDialog memory={editMemory} open={editOpen} onOpenChange={setEditOpen} onSaved={handleSaved} />
      <MemoryDeleteDialog memory={deleteMemory} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={handleDeleted} />
    </div>
  );
}
