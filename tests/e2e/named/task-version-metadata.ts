import { expect, it } from "vitest";
import { updateTask } from "../../../src/lib/tasks";
import { ApiError } from "../../../src/lib/http";

it("retains stale actor/current metadata internally without applying the rejected edit", async () => {
  if (!process.env.SHO_TASK_VERSION_FIXTURE) throw new Error("The APL-2648 parent must supply its disposable task fixture.");
  const f = JSON.parse(process.env.SHO_TASK_VERSION_FIXTURE) as { userId: string; userName: string; taskId: string; seen: string; title: string; updatedAt: string; rejectedTitle: string };
  let conflict: unknown;
  try { await updateTask({ id: f.userId, orgRole: "SUPER_ADMIN", name: f.userName }, f.taskId, { title: f.rejectedTitle, expectedUpdatedAt: f.seen }); }
  catch (error) { conflict = error; }
  expect(conflict).toBeInstanceOf(ApiError);
  const typed = conflict as ApiError;
  expect(typed.status).toBe(409);
  expect(typed.code).toBe("version_conflict");
  expect(typed.extra).toMatchObject({ stale: true, changedBy: f.userName, current: { title: f.title, updatedAt: new Date(f.updatedAt) } });
});
