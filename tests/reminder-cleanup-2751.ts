// API-only cleanup for run-owned ZZ-TEST reminder fixtures; state makes retries idempotent.
export type ReminderResources = {
  projects: { id: string; leaderId: string; archived: boolean }[];
  people: { id: string; deactivated: boolean }[];
  organisations: { id: string; archived: boolean }[];
};
export const reminderResources = (): ReminderResources => ({ projects: [], people: [], organisations: [] });
type Call = (path: string, body?: unknown) => Promise<{ status: number }>;
export async function cleanupReminderResources(rootId: string, post: Call, resources: ReminderResources) {
  const failures: string[] = [];
  for (const p of resources.projects) {
    if (p.archived) continue;
    try {
      if (p.leaderId !== rootId) {
        const r = await post(`/api/projects/${p.id}/leader`, { newLeaderId: rootId, previousRole: "REMOVE", handoverTo: rootId });
        if (r.status !== 200) throw new Error(`leader ${r.status}`);
        p.leaderId = rootId;
      }
      const r = await post(`/api/projects/${p.id}/archive`);
      if (r.status !== 200) throw new Error(`archive ${r.status}`);
      p.archived = true;
    } catch { failures.push("project cleanup failed"); }
  }
  for (const p of resources.people) {
    if (p.deactivated) continue;
    if (p.id === rootId) { failures.push("refusing to deactivate cleanup owner"); continue; }
    try {
      const r = await post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" });
      if (r.status !== 200) throw new Error(`deactivate ${r.status}`);
      p.deactivated = true;
    } catch { failures.push("person cleanup failed"); }
  }
  for (const org of resources.organisations) {
    if (org.archived) continue;
    try {
      const r = await post(`/api/orgs/${org.id}/archive`, { archive: true });
      if (r.status !== 200) throw new Error(`organisation ${r.status}`);
      org.archived = true;
    } catch { failures.push("organisation cleanup failed"); }
  }
  if (failures.length) throw new Error(`Reminder fixture cleanup incomplete: ${failures.join(", ")}`);
}
