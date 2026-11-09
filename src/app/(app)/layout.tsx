import { multiWorkspaceEnabled } from "@/lib/workspace-authority";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { ApiError } from "@/lib/http";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser, publicUser } from "@/lib/auth";
import { RETURN_PATH_HEADER, returnToEnabled, signedOutSignInHref } from "@/lib/return-to";
import { ReturnToBridge } from "@/components/ReturnToBridge";
import { Shell, type Me } from "./Shell";
import { SetOwnPassword } from "./SetOwnPassword";
import { crmVisible } from "@/lib/crm";
import { workloadAvailable } from "@/lib/workload";
import { leadsAnyDeal } from "@/lib/review";
import { UndoHost } from "@/components/UndoHost";
import "./app.css";
import "./touch.css";
import "./density.css";

async function Gate({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await currentUser({ allowTempPassword: true });
  } catch (error) {
    if(error instanceof ApiError && error.extra?.code==="WORKSPACE_UNAVAILABLE") return <WorkspaceSwitcher recovery />;
    // APL-2652. Come back to the path they asked for. Flag off is plain /signin, the same as main.
    redirect(signedOutSignInHref((await headers()).get(RETURN_PATH_HEADER)));
  }
  // SHO-US-23.5: on a Super-Admin-issued password, this screen stands in for every page (the page itself is never rendered).
  // Saving refreshes the same URL, so the person lands on the page they asked for.
  if (user.tempPasswordAt) return <>{returnToEnabled() ? <ReturnToBridge /> : null}<SetOwnPassword email={user.email} /></>;
  return <>{returnToEnabled() ? <ReturnToBridge /> : null}<Shell user={{ ...(publicUser(user) as Me), multiWorkspace:multiWorkspaceEnabled(), compact: user.compactRows, crm: crmVisible(user), review: await leadsAnyDeal(user), workload: await workloadAvailable(user), startGuide: !user.startGuideDismissedAt }}>{children}</Shell><UndoHost /></>;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}><Skeleton /></div>}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
