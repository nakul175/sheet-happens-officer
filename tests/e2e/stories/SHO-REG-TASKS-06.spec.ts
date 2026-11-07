import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { local2691, test } from "../helpers/2691-admin";
import { newProject, newTask } from "../helpers/migration-2731";
import { account } from "../local-api";
import { expect, zz } from "./qa";

test("SHO-REG-TASKS-06 approver deactivation gives the Leader a visible recovery path", async ({ admin, later }) => {
  if (!local2691) throw new Error("Approver recovery needs the guarded local test database.");
  const fixture = randomUUID();
  const evidenceDir = "test-results/approver-recovery";
  const people: string[] = [];
  const projects: string[] = [];
  later(async () => {
    for (const id of projects) {
      const project = await admin.api.get(`/api/projects/${id}`);
      expect(project.status).toBe(200);
      expect(project.json.project.archived).toBe(true);
    }
    for (const id of people) {
      const person = await admin.api.get(`/api/team/${id}`);
      expect(person.status).toBe(200);
      expect(person.json.person.status).toBe("DEACTIVATED");
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, projects, people, archived: true, deactivated: true }, null, 2));
  });
  const project = await newProject(admin, later, { label: `approver recovery ${fixture}` });
  projects.push(project.id);
  const worker = await account(zz(`worker ${fixture}`), `nakul17+zz-tasks06-${fixture}-worker@aplyd.com`);
  people.push(worker.id);
  const approver = await account(zz(`approver ${fixture}`), `nakul17+zz-tasks06-${fixture}-approver@aplyd.com`);
  people.push(approver.id);
  for (const id of [worker.id, approver.id]) {
    later(async () => {
      const person = await admin.api.get(`/api/team/${id}`);
      expect(person.status).toBe(200);
      if (person.json.person.status !== "DEACTIVATED") {
        const result = await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
        expect(result.status, JSON.stringify(result.json)).toBe(200);
      }
    });
    const added = await admin.api.post(`/api/projects/${project.id}/members`, { userId: id, role: "EDITOR" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }
  const title = zz(`approval recovery ${fixture}`);
  const taskId = await newTask(admin, project.id, { title, assigneeId: worker.id, approverId: approver.id });
  expect((await worker.c.post(`/api/tasks/${taskId}/send-for-approval`)).status).toBe(200);
  const handoff = await admin.api.post(`/api/team/${approver.id}/deactivate`, { reassign: "leaders" });
  expect(handoff.status, JSON.stringify(handoff.json)).toBe(200);
  const recovered = await admin.api.get(`/api/tasks/${taskId}`);
  expect(recovered.status).toBe(200);
  expect(recovered.json.task).toMatchObject({ approver: { id: admin.user.id }, assignee: { id: admin.user.id }, awaitingApproval: true });

  await admin.page.goto("/my-tasks");
  const waiting = admin.page.getByRole("region", { name: "Waiting on me" });
  await expect(waiting.getByText(title)).toBeVisible();
  await admin.page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(admin.page.getByRole("dialog", { name: "Notifications" }).getByText(/you now approve 1 task/)).toBeVisible();
  await admin.page.getByRole("button", { name: /^Notifications/ }).click();
  await waiting.getByRole("button", { name: `Close "${title}"` }).click();
  await expect(waiting.getByText(title)).toHaveCount(0);
  const closed = await admin.api.get(`/api/tasks/${taskId}`);
  expect(closed.status).toBe(200);
  expect(closed.json.task.completedAt).toBeTruthy();
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, projectId: project.id, taskId, recoveredApprover: admin.user.id, recoveryNoticeVisible: true, waitingRowVisible: true, leaderClosedTask: true }, null, 2));
});
