import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser, publicUser } from "@/lib/auth";
import { Shell, type Me } from "./Shell";
import { UndoHost } from "@/components/UndoHost";
import "./app.css";

async function Gate({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await currentUser();
  } catch {
    redirect("/signin");
  }
  return <><Shell user={publicUser(user) as Me}>{children}</Shell><UndoHost /></>;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<div className="skel" style={{ padding: 24 }}>Loading…</div>}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
