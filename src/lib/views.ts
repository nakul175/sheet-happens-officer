// SHO-US-14.10: saved views. Personal to one person; up to 10 per project; the project's Leader, Editors and Viewers may each keep their own.
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";
import { projectAccess, type Actor } from "@/lib/access";

export const MAX_VIEWS = 10;

export const viewState = z.object({
  assignee: z.string().max(60).default(""),
  flags: z.array(z.enum(["overdue", "blocked", "awaiting", "nodate"])).max(4).default([]),
  priority: z.enum(["", "LOW", "MEDIUM", "HIGH", "URGENT"]).default(""),
  sort: z.enum(["date", "priority"]).default("date"),
  group: z.enum(["section", "assignee", "week"]).default("section"),
});
export const viewCreate = z.object({ name: z.string().trim().min(1, "Give the view a name.").max(40, "Keep the name to 40 characters."), state: viewState });
export const viewRename = z.object({ name: z.string().trim().min(1, "Give the view a name.").max(40, "Keep the name to 40 characters.") });

const present = (v: { id: string; name: string; state: unknown }) => ({ id: v.id, name: v.name, state: viewState.parse(v.state ?? {}) });

export async function listViews(user: Actor, projectId: string) {
  await projectAccess(user, projectId);
  const rows = await db.savedView.findMany({ where: { userId: user.id, projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return { views: rows.map(present), max: MAX_VIEWS };
}

export async function createView(user: Actor, projectId: string, input: z.infer<typeof viewCreate>) {
  await projectAccess(user, projectId);
  const mine = await db.savedView.findMany({ where: { userId: user.id, projectId }, select: { name: true, position: true } });
  if (mine.length >= MAX_VIEWS) throw new ApiError(409, `You can keep up to ${MAX_VIEWS} saved views in a project. Delete one to save another.`);
  if (mine.some((v) => v.name.toLowerCase() === input.name.toLowerCase())) throw new ApiError(409, "You already have a view with that name.");
  const row = await db.savedView.create({ data: { userId: user.id, projectId, name: input.name, state: input.state, position: Math.max(-1, ...mine.map((v) => v.position)) + 1 } });
  return present(row);
}

/** Someone else's view is reported as missing, never as forbidden. */
export async function ownView(user: Actor, id: string) {
  const v = await db.savedView.findFirst({ where: { id, userId: user.id } });
  if (!v) throw notFound("View");
  return v;
}

export async function renameView(user: Actor, id: string, name: string) {
  const v = await ownView(user, id);
  const clash = await db.savedView.findFirst({ where: { userId: user.id, projectId: v.projectId, name: { equals: name, mode: "insensitive" }, id: { not: id } } });
  if (clash) throw new ApiError(409, "You already have a view with that name.");
  return present(await db.savedView.update({ where: { id }, data: { name } }));
}

export async function deleteView(user: Actor, id: string) {
  await ownView(user, id);
  await db.savedView.delete({ where: { id } });
}
