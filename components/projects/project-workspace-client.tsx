"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageSquare, Plus, Pin, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { formatDate } from "@/lib/utils";
import { JOB_STATUS_LABELS, JOB_TYPE_LABELS } from "@/lib/jobs/status-transitions";
import { t } from "@/lib/i18n/dictionary";
import type { Job, JobStatus, Project } from "@/lib/types/database";
import type { Chat, MemoryItem } from "@/lib/types/workspace";

type Tab = "chats" | "instructions" | "memory" | "jobs" | "results";

interface ProjectWorkspaceProps {
  project: Project;
  jobs: Job[];
  members: Array<{ user_id: string; member_role: string; profiles: unknown }>;
}

export function ProjectWorkspaceClient({ project, jobs, members }: ProjectWorkspaceProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("chats");
  const [chats, setChats] = useState<Chat[]>([]);
  const [memory, setMemory] = useState<MemoryItem[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(project.system_prompt ?? "");
  const [newMemory, setNewMemory] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/chats?projectId=${project.id}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setChats(d.data.chats); });

    fetch(`/api/memory?scope=project&projectId=${project.id}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setMemory(d.data.items); });
  }, [project.id]);

  const createChat = async () => {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    const data = await res.json();
    if (data.ok) router.push(`/chat/${data.data.id}`);
  };

  const saveInstructions = async () => {
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addMemory = async () => {
    if (!newMemory.trim()) return;
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", projectId: project.id, content: newMemory }),
    });
    const data = await res.json();
    if (data.ok) {
      setMemory((prev) => [data.data, ...prev]);
      setNewMemory("");
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "chats", label: t("projects.chats") },
    { id: "instructions", label: t("projects.instructions") },
    { id: "memory", label: t("projects.memory") },
    { id: "jobs", label: t("projects.jobs") },
    { id: "results", label: t("projects.results") },
  ];

  return (
    <div className="flex flex-1 flex-col p-4 md:p-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <p className="mt-1 text-muted-foreground">{project.description || "—"}</p>
          </div>
          <Button onClick={createChat}>
            <MessageSquare className="h-4 w-4" />
            {t("nav.newChat")}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1 border-b border-border">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                tab === id
                  ? "border-accent text-accent font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "chats" && (
          <div className="space-y-2">
            {chats.length === 0 ? (
              <EmptyState
                title={t("chat.empty")}
                description="Создайте чат в контексте этого проекта."
                action={<Button onClick={createChat}><Plus className="h-4 w-4" />{t("chat.newChat")}</Button>}
              />
            ) : (
              chats.map((chat) => (
                <Link
                  key={chat.id}
                  href={`/chat/${chat.id}`}
                  className="flex items-center justify-between rounded-xl border border-border px-4 py-3 transition-colors hover:border-accent/30"
                >
                  <div>
                    <p className="font-medium text-sm">{chat.title}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(chat.updated_at)}</p>
                  </div>
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                </Link>
              ))
            )}
          </div>
        )}

        {tab === "instructions" && (
          <Card>
            <CardHeader><CardTitle>{t("projects.instructions")}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>System prompt проекта</Label>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={8}
                  placeholder="Инструкции, которые применяются ко всем чатам этого проекта…"
                  className="mt-1"
                />
              </div>
              <Button onClick={saveInstructions}>
                <Save className="h-4 w-4" />
                {saved ? t("settings.saved") : t("common.save")}
              </Button>
            </CardContent>
          </Card>
        )}

        {tab === "memory" && (
          <div className="space-y-4">
            <Card>
              <CardContent className="flex gap-2 pt-6">
                <Textarea
                  value={newMemory}
                  onChange={(e) => setNewMemory(e.target.value)}
                  placeholder="Добавить факт в память проекта…"
                  rows={2}
                  className="flex-1"
                />
                <Button onClick={addMemory} disabled={!newMemory.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
            {memory.length === 0 ? (
              <EmptyState title="Память проекта пуста" />
            ) : (
              memory.map((item) => (
                <Card key={item.id}>
                  <CardContent className="flex items-start justify-between py-3">
                    <p className="text-sm">{item.content}</p>
                    {item.pinned && <Pin className="h-4 w-4 text-accent" />}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === "jobs" && (
          <div className="space-y-2">
            {jobs.length === 0 ? (
              <EmptyState title="Задач пока нет" />
            ) : (
              jobs.map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="flex items-center justify-between rounded-xl border border-border px-4 py-3 hover:border-accent/30"
                >
                  <div>
                    <p className="font-medium text-sm">{JOB_TYPE_LABELS[job.type] ?? job.type}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(job.created_at)}</p>
                  </div>
                  <Badge status={job.status as JobStatus} label={JOB_STATUS_LABELS[job.status as JobStatus]} />
                </Link>
              ))
            )}
          </div>
        )}

        {tab === "results" && (
          <EmptyState
            title={t("assets.empty")}
            description="Результаты проекта доступны в разделе Результаты с фильтром по проекту."
            action={<Button><Link href="/results">{t("nav.results")}</Link></Button>}
          />
        )}

        <Card>
          <CardHeader><CardTitle>{t("projects.members")}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {members.map((m) => {
              const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles as { display_name?: string; email?: string } | null;
              return (
                <div key={m.user_id} className="text-sm">
                  <p>{profile?.display_name ?? profile?.email ?? m.user_id}</p>
                  <p className="text-xs text-muted-foreground">{m.member_role}</p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
