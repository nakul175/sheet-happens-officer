"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { TaskModal } from "@/components/TaskModal";
import { Page, useMe } from "../../Shell";

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const router = useRouter();
  return (
    <Page>
      <TaskModal asPage id={id} me={me.id} onClose={() => router.push("/")} />
    </Page>
  );
}
