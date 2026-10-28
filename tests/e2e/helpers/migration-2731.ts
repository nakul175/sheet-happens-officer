// Current-API fixtures for the migrated APL-2731 baseline; shared main harness stays unchanged.
import { newProject as baseProject, newTask as baseTask, ghost as baseGhost } from "../g2";
import { archiveProject } from "../stories/qa";
export * from "../g2";

export const newTask: typeof baseTask = (who, projectId, body = {}) =>
  baseTask(who, projectId, { dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), ...body });

export const newProject: typeof baseProject = async (admin, later, options) => {
  let project: Awaited<ReturnType<typeof baseProject>> | undefined = undefined;
  project = await baseProject(admin, fn => later(() => project ? archiveProject(admin.api, project.id, admin.user.id) : fn()), options);
  return project;
};

import { expect, type Who } from "../support";
import { deactivate } from "../stories/qa";
export { archiveProject, deactivate };

/** Read the actual version without masking a permission refusal with a privileged read. */
export async function postTaskCurrent(who: Pick<Who, "api">, id: string, action: string, body: Record<string, unknown> = {}) {
  const loaded = await who.api.get(`/api/tasks/${id}`);
  const version = loaded.status === 200 ? { expectedUpdatedAt: loaded.json.task.updatedAt } : {};
  return who.api.post(`/api/tasks/${id}/${action}`, { ...version, ...body });
}

/** Archived projects reject membership edits; reopen this owned fixture briefly, remove its test member, and archive again. */
export async function removeMember(admin: Pick<Who, "api" | "user">, projectId: string, userId: string) {
  const loaded = await admin.api.get(`/api/projects/${projectId}`);
  expect(loaded.status, JSON.stringify(loaded.json)).toBe(200);
  const wasArchived = loaded.json.project.archived;
  if (wasArchived) expect((await admin.api.post(`/api/projects/${projectId}/unarchive`)).status).toBe(200);
  try {
    const members = loaded.json.project.members as { userId: string }[];
    if (members.some(m => m.userId === userId)) {
      const removed = await admin.api.del(`/api/projects/${projectId}/members/${userId}?handoverTo=${admin.user.id}`);
      expect(removed.status, JSON.stringify(removed.json)).toBe(204);
    }
  } finally {
    if (wasArchived) await archiveProject(admin.api, projectId, admin.user.id);
  }
}

export const ghost: typeof baseGhost = async (admin, later, label) => {
  let person: Awaited<ReturnType<typeof baseGhost>> | undefined = undefined;
  person = await baseGhost(admin, fn => later(() => person ? deactivate(admin.api, person.id) : fn()), label);
  return person;
};

/** A fixture already in Trash or an archived project is already absent from active task lists. */
export async function deleteFixtureTask(admin: Pick<Who, "api">, id: string) {
  const loaded = await admin.api.get(`/api/tasks/${id}`);
  if (loaded.status === 404) return;
  expect(loaded.status, JSON.stringify(loaded.json)).toBe(200);
  if (loaded.json.task.project.archived) return;
  const removed = await admin.api.del(`/api/tasks/${id}`);
  expect(removed.status, JSON.stringify(removed.json)).toBe(204);
  expect((await admin.api.get(`/api/tasks/${id}`)).status).toBe(404);
}
