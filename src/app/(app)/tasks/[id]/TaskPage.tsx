"use client";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useGet } from "@/components/api";
import { TaskModal } from "@/components/TaskModal";
import { Page, useMe } from "../../Shell";

/** A task link opens the task over its project's list (SHO-US-5.5 journey); an unavailable task shows the standalone notice. */
export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const router = useRouter();
  const t = useGet<{ task: { projectId: string } }>(`/api/tasks/${id}`);
  const projectId = t.data?.task.projectId;
  useEffect(() => { if (projectId) router.replace(`/projects/${projectId}?task=${id}`); }, [projectId, id, router]);
  if (t.loading || projectId) return <Page><div className="skel">Opening the task…</div></Page>;
  return (
    <Page>
      <TaskModal asPage id={id} me={me.id} onClose={() => router.push("/")} />
    </Page>
  );
}
