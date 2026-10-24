"use client";
import { useGet } from "@/components/api";
import { Page, useMe } from "../Shell";
import { USAGE_SUB, UsageContents, usagePath, usageTitle, type UsagePayload } from "./screen";

export default function UsageView() {
  const me = useMe();
  const u = useGet<UsagePayload>(usagePath(me.orgRole));
  const allowed = usagePath(me.orgRole);
  return (
    <Page title={usageTitle(me.orgRole)} sub={allowed ? USAGE_SUB : undefined}>
      <UsageContents role={me.orgRole} loading={u.loading} error={u.error} data={u.data} />
    </Page>
  );
}
