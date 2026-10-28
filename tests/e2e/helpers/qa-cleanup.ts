/** Cleanup diagnostics contain only fixed labels and HTTP status numbers, never response/error bodies. */
export function reportRestoreFailure(status: number) {
  console.warn("[qa-alias] Cannot restore pool person: Team read failed", Number.isInteger(status) ? status : "invalid status");
}

type PoolApi = {
  get: (path: string) => Promise<{ status: number; json: { person?: { status?: string; orgRole?: string } } }>;
  post: (path: string) => Promise<{ status: number }>;
  patch: (path: string, body: { orgRole: string }) => Promise<{ status: number }>;
};

export async function restorePoolPerson(api: PoolApi, id: string) {
  const seen = await api.get(`/api/team/${id}`);
  if (seen.status !== 200) { reportRestoreFailure(seen.status); return; }
  if (seen.json.person?.status === "DEACTIVATED") {
    const back = await api.post(`/api/team/${id}/reactivate`);
    if (back.status !== 200) throw new Error("Pool person reactivation failed");
  }
  if (seen.json.person?.orgRole !== "MEMBER") {
    const role = await api.patch(`/api/team/${id}`, { orgRole: "MEMBER" });
    if (role.status !== 200) throw new Error("Pool person role restoration failed");
  }
}

/** Best effort means continue every cleanup; a failure must still be visible without printing secrets. */
export async function runCleanup(callbacks: (() => Promise<unknown>)[]) {
  for (const fn of [...callbacks].reverse()) {
    try { await fn(); }
    catch { console.warn("[story-cleanup] Cleanup failed; continuing remaining cleanup (details omitted to protect credentials)"); }
  }
}
