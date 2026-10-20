import { Suspense } from "react";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { visibleTask } from "@/lib/tasks";
import TaskPage from "./TaskPage";

export const metadata = { title: "Task · Sheet Happens Officer" };

export default async function Page({ params }: PageProps<"/tasks/[id]">) {
  const { id } = await params;
  let user;
  try {
    user = await currentUser({ allowTempPassword: true });
  } catch (err) {
    // Signed out: the layout sends them to sign-in. This must not become a 404.
    if (err instanceof ApiError && err.status === 401) return <Suspense><TaskPage params={params} /></Suspense>;
    throw err;
  }
  // The password wall replaces this page. A 404 here would hide that screen.
  if (!user.tempPasswordAt) {
    try {
      await visibleTask(user, id);
    } catch (err) {
      // Document GETs are already a 404 from proxy (the shell streams, which would lock status at 200).
      // This still draws the not-found screen for a client navigation.
      if (err instanceof ApiError && err.status === 404) notFound();
      throw err;
    }
  }
  return <Suspense><TaskPage params={params} /></Suspense>;
}
