import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { redirect } from "next/navigation";
import { currentUser, publicUser } from "@/lib/auth";
import { Shell, type Me } from "./Shell";
import { SetOwnPassword } from "./SetOwnPassword";
import { crmVisible } from "@/lib/crm";
import { leadsAnyDeal } from "@/lib/review";
import { UndoHost } from "@/components/UndoHost";
import "./app.css";
import "./touch.css";
import "./density.css";

async function Gate({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await currentUser({ allowTempPassword: true });
  } catch {
    redirect("/signin");
  }
  // SHO-US-23.5: on a Super-Admin-issued password, this screen stands in for every page (the page itself is never rendered).
  // Saving refreshes the same URL, so the person lands on the page they asked for.
  if (user.tempPasswordAt) return <SetOwnPassword email={user.email} />;
  return <><Shell user={{ ...(publicUser(user) as Me), compact: user.compactRows, crm: crmVisible(user), review: await leadsAnyDeal(user), startGuide: !user.startGuideDismissedAt }}>{children}</Shell><UndoHost /></>;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}><Skeleton /></div>}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
