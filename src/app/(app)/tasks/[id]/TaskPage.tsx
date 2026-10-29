"use client";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useGet } from "@/components/api";
import { returnToEnabled } from "@/lib/return-to";
import { TaskModal } from "@/components/TaskModal";
import { Page, useMe } from "../../Shell";

/**
 * A task link opens the task over its project's list (SHO-US-5.5 journey).
 * An unavailable task shows the standalone notice.
 * APL-2652: with the return path on, stay on /tasks/<id> and keep the query, including ?tab.
 */
export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const router = useRouter();
  const t = useGet<{ task: { projectId: string } }>(`/api/tasks/${id}`);
  const projectId = t.data?.task.projectId;
  const stay = returnToEnabled();
  useEffect(() => {
    if (!projectId || stay) return;
    router.replace(`/projects/${projectId}?task=${id}`);
  }, [projectId, id, router, stay]);
  if (t.loading || (projectId && !stay)) return <Page><div className="skel">Opening the task…</div></Page>;
  return (
    <Page>
      <h1 className="sr-only">Task</h1>
      <TaskModal asPage id={id} me={me.id} onClose={() => router.push("/")} />
    </Page>
  );
}
