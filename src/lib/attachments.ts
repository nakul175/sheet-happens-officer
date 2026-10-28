// SHO-2591 / 19.2a. Metadata and test-only PDF flow; no real storage selection.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { projectAccess, requireWrite, WORKSTREAM_DEAL, type Actor, type Tx } from "@/lib/access";
import { attachmentsEnabled } from "@/lib/flags";
import { attachmentStore } from "@/lib/attachment-store";
import { logAction } from "@/lib/notify";
import { isTooOldToUndo, trashPurgeBefore } from "@/lib/undoable";

// Provisional test-slice limits, not approved production policy (FR19.2-02).
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
export const attachmentFilename = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
export function requireAttachments() { if (!attachmentsEnabled()) throw notFound(); }
export async function attachmentTask(user: Actor, taskId: string, write = false) {
  requireAttachments();
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) throw notFound("Task");
  let access;
  try { access = await projectAccess(user, task.projectId, { write }); }
  catch (e) { if (e instanceof ApiError && e.status === 404) throw notFound("Task"); throw e; }
  // Deal files (19.2c) are a separate, blocked story.
  if (access.project.typeId === WORKSTREAM_DEAL) throw notFound("Task");
  if (write) requireWrite(access);
  return { task, access };
}
export async function attachmentRoom(tx: Tx, taskId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) throw notFound("Task");
  if (await tx.taskAttachment.count({ where: { taskId, removedAt: null } }) >= ATTACHMENT_MAX_COUNT) throw new ApiError(400, "A task can have at most 10 files in this test slice.", { code: "too_many_files" });
}
export function validateAttachment(file: { name: string; type: string; size: number }, bytes?: Uint8Array) {
  const filename = attachmentFilename(file.name);
  if (!filename || !/\.pdf$/i.test(filename) || file.type !== "application/pdf") throw new ApiError(400, "This test slice accepts PDF files only.", { code: "type_not_allowed" });
  if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES) throw new ApiError(400, "Choose a PDF of up to 25 MB.", { code: "file_too_large" });
  if (bytes && (bytes.length !== file.size || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-")) throw new ApiError(400, "This file does not have a PDF header.", { code: "type_not_allowed" });
  return filename;
}
const present = (a: {id:string;filename:string;mimeType:string;size:number;createdAt:Date}) => ({id:a.id,filename:a.filename,mimeType:a.mimeType,size:a.size,createdAt:a.createdAt.toISOString()});
export async function listAttachments(user: Actor, taskId: string) {
  const { access } = await attachmentTask(user, taskId);
  const rows = await db.taskAttachment.findMany({ where: { taskId, removedAt: null }, orderBy: { createdAt: "asc" } });
  return { files: rows.map(present), canWrite: access.role !== "VIEWER" && !access.project.archivedAt };
}
export async function addAttachment(user: Actor, taskId: string, file: File) {
  await attachmentTask(user, taskId, true);
  const filename = validateAttachment(file);
  const bytes = new Uint8Array(await file.arrayBuffer()); validateAttachment(file, bytes);
  const store = attachmentStore(), storageKey = randomUUID();
  let written = false;
  try {
    return await db.$transaction(async tx => {
      await attachmentRoom(tx, taskId);
      await attachmentTask(user, taskId, true); // recheck revocation/archive after buffering, before storing
      // Rejected validation/limit checks occur before creating either object or metadata.
      written = true; await store.put(storageKey, bytes);
      const row = await tx.taskAttachment.create({ data: { taskId, filename, mimeType: "application/pdf", size: bytes.length, storageKey, uploadedById: user.id } });
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await logAction(tx, { actorId: user.id, projectId: task.projectId, targetType: "task", targetId: taskId, action: "attachment.added", after: { attachmentId: row.id, filename } });
      return present(row);
    });
  } catch (e) { if (written) await store.remove(storageKey); throw e; }
}
async function fileFor(user: Actor, taskId: string, id: string, write: boolean) {
  const scope = await attachmentTask(user, taskId, write);
  const file = await db.taskAttachment.findFirst({ where: { id, taskId } });
  if (!file) throw notFound("File");
  return { ...scope, file };
}
export async function downloadAttachment(user: Actor, taskId: string, id: string) {
  const { file } = await fileFor(user, taskId, id, false);
  if (file.removedAt) throw notFound("File");
  const bytes = await attachmentStore().get(file.storageKey);
  if (!bytes) throw notFound("File");
  return { filename: file.filename, bytes };
}
export async function softRemoveAttachmentRow(tx: Tx, taskId: string, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
  const task = await tx.task.findUnique({ where: { id: taskId } });
  const file = await tx.taskAttachment.findFirst({ where: { id, taskId } });
  if (!task || task.deletedAt || !file || file.removedAt) throw notFound("File");
  await tx.taskAttachment.update({ where: { id }, data: { removedAt: new Date() } });
}
export async function removeAttachment(user: Actor, taskId: string, id: string) {
  const { task, file } = await fileFor(user, taskId, id, true);
  if (file.removedAt) throw notFound("File");
  await db.$transaction(async tx => {
    await softRemoveAttachmentRow(tx, taskId, id);
    await logAction(tx, { actorId: user.id, projectId: task.projectId, targetType: "task", targetId: taskId, action: "attachment.removed", before: { attachmentId: id, filename: file.filename }, after: { attachmentId: id, filename: file.filename } });
  });
}
export async function restoreAttachmentRow(tx: Tx, taskId: string, id: string) {
  await attachmentRoom(tx, taskId);
  const file = await tx.taskAttachment.findFirst({ where: { id, taskId } });
  if (!file || !file.removedAt || isTooOldToUndo(file.removedAt)) throw new ApiError(409, "This file is no longer available to restore.");
  await tx.taskAttachment.update({ where: { id }, data: { removedAt: null } });
}
export async function restoreAttachment(user: Actor, taskId: string, id: string) {
  const { task, file } = await fileFor(user, taskId, id, true);
  await db.$transaction(async tx => {
    await restoreAttachmentRow(tx, taskId, id);
    await logAction(tx, { actorId: user.id, projectId: task.projectId, targetType: "task", targetId: taskId, action: "attachment.restored", before: { attachmentId: id, filename: file.filename }, after: { attachmentId: id, filename: file.filename } });
  });
}
export async function attachmentTrash(user: Actor, projectId: string) {
  requireAttachments();
  const access = await projectAccess(user, projectId);
  if (access.project.typeId === WORKSTREAM_DEAL) throw notFound();
  const rows = await db.taskAttachment.findMany({ where: { task: { projectId, deletedAt: null }, removedAt: { not: null } }, orderBy: { removedAt: "desc" } });
  return { canWrite: access.role !== "VIEWER" && !access.project.archivedAt, files: rows.map(row => ({ ...present(row), taskId: row.taskId, daysLeft: Math.max(0, 30-Math.floor((Date.now()-row.removedAt!.getTime())/86400000)) })) };
}
/** Objects must be removed before DB cascade deletion; runs even with the UI flag off. */
export async function removeTaskAttachmentObjects(tx: Tx, ids: string[]) {
  const rows = await tx.taskAttachment.findMany({ where: { OR: [{ taskId: { in: ids } }, { task: { parentId: { in: ids } } }] }, select: { storageKey: true } });
  if (!rows.length) return;
  const store = attachmentStore();
  for (const row of rows) await store.remove(row.storageKey);
}
export async function purgeExpiredAttachments(now = new Date()) {
  const rows = await db.taskAttachment.findMany({ where: { removedAt: { lt: trashPurgeBefore(now) } }, select: { id: true, taskId: true } });
  if (!rows.length) return 0;
  const store = attachmentStore(); let count = 0;
  for (const row of rows) await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM "Task" WHERE "id" = ${row.taskId} FOR UPDATE`;
    const live = await tx.taskAttachment.findFirst({ where: { id: row.id, removedAt: { lt: trashPurgeBefore(now) } } });
    if (!live) return;
    await store.remove(live.storageKey);
    await tx.taskAttachment.delete({ where: { id: live.id } }); count++;
  });
  return count;
}
