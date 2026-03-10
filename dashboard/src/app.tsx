import * as React from "react";
import { MemoryTable } from "@/components/memory-table";
import { AgentsTable } from "@/components/agents-table";
import { ProjectsTable } from "@/components/projects-table";
import { StatsView } from "@/components/stats-view";
import { SearchBar } from "@/components/search-bar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Memory, Agent, Project, MemoryStats } from "@/types";
import { BrainCircuit, Users, FolderKanban, BarChart3 } from "lucide-react";

const API_BASE = "/api";

export function App() {
  const [memories, setMemories] = React.useState<Memory[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [stats, setStats] = React.useState<MemoryStats | null>(null);
  const [selectedMemory, setSelectedMemory] = React.useState<Memory | null>(null);
  const [activeTab, setActiveTab] = React.useState("memories");

  const fetchMemories = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/memories?limit=200`);
      const data = await res.json();
      setMemories(data.memories || []);
    } catch { /* ignore */ }
  }, []);

  const fetchAgents = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/agents`);
      const data = await res.json();
      setAgents(data.agents || []);
    } catch { /* ignore */ }
  }, []);

  const fetchProjects = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`);
      const data = await res.json();
      setProjects(data.projects || []);
    } catch { /* ignore */ }
  }, []);

  const fetchStats = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/memories/stats`);
      const data = await res.json();
      setStats(data);
    } catch { /* ignore */ }
  }, []);

  const fetchAll = React.useCallback(() => {
    fetchMemories();
    fetchAgents();
    fetchProjects();
    fetchStats();
  }, [fetchMemories, fetchAgents, fetchProjects, fetchStats]);

  React.useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleSearch = React.useCallback(async (query: string) => {
    if (!query.trim()) { fetchMemories(); return; }
    try {
      const res = await fetch(`${API_BASE}/memories/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      setMemories((data.results || []).map((r: any) => r.memory || r));
    } catch { /* ignore */ }
  }, [fetchMemories]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrainCircuit className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Mementos</h1>
              <p className="text-sm text-muted-foreground">Agent Memory System</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">
              {memories.length} memories &middot; {agents.length} agents
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="memories" className="gap-2">
                <BrainCircuit className="h-4 w-4" /> Memories
              </TabsTrigger>
              <TabsTrigger value="agents" className="gap-2">
                <Users className="h-4 w-4" /> Agents
              </TabsTrigger>
              <TabsTrigger value="projects" className="gap-2">
                <FolderKanban className="h-4 w-4" /> Projects
              </TabsTrigger>
              <TabsTrigger value="stats" className="gap-2">
                <BarChart3 className="h-4 w-4" /> Stats
              </TabsTrigger>
            </TabsList>
            {activeTab === "memories" && <SearchBar onSearch={handleSearch} />}
          </div>

          <TabsContent value="memories">
            <MemoryTable memories={memories} selectedMemory={selectedMemory} onSelectMemory={setSelectedMemory} />
          </TabsContent>
          <TabsContent value="agents">
            <AgentsTable agents={agents} />
          </TabsContent>
          <TabsContent value="projects">
            <ProjectsTable projects={projects} />
          </TabsContent>
          <TabsContent value="stats">
            <StatsView stats={stats} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
