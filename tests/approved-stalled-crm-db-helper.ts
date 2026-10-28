// Approved DB helper for the APL-2741 stalled-CRM tests.
// Every mutating operation refuses non-local databases and verifies the exact ZZ-TEST rows first.
import { db } from "../src/lib/db";

type ZzPerson = { id: string; email: string; name: string };
type ZzProject = { id: string; name: string };
type OrgRole = "ADMIN" | "SUPER_ADMIN";

export function assertLocalTestDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  let host = "";
  try {
    host = new URL(raw.replace(/^postgres(ql)?:/i, "http:")).hostname;
  } catch {
    throw new Error("DATABASE_URL must point at the local test database");
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") {
    throw new Error("Refusing to run: stalled-deal tests use the local test database only");
  }
}

function assertZzPersonShape(person: ZzPerson) {
  if (!person.name.startsWith("ZZ-TEST ") || !person.email.startsWith("nakul17+zz-2741-")) {
    throw new Error(`Refusing non-ZZ-TEST person ${person.id}`);
  }
}

async function verifyZzPeople(people: ZzPerson[]) {
  assertLocalTestDatabase();
  for (const person of people) assertZzPersonShape(person);
  const rows = await db.user.findMany({
    where: { id: { in: people.map((person) => person.id) } },
    select: { id: true, email: true, name: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const person of people) {
    const row = byId.get(person.id);
    if (!row || row.email !== person.email || row.name !== person.name) {
      throw new Error(`Refusing unverified ZZ-TEST person ${person.id}`);
    }
  }
}

async function verifyZzProjects(projects: ZzProject[]) {
  assertLocalTestDatabase();
  if (projects.some((project) => !project.name.startsWith("ZZ-TEST "))) {
    throw new Error("Refusing non-ZZ-TEST project");
  }
  const rows = await db.project.findMany({
    where: { id: { in: projects.map((project) => project.id) } },
    select: { id: true, name: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  for (const project of projects) {
    if (byId.get(project.id) !== project.name) throw new Error(`Refusing unverified ZZ-TEST project ${project.id}`);
  }
}

export async function setZzOrgRoles(entries: { person: ZzPerson; role: OrgRole }[]) {
  await verifyZzPeople(entries.map((entry) => entry.person));
  await db.$transaction(entries.map((entry) => db.user.update({
    where: { id: entry.person.id },
    data: { orgRole: entry.role },
  })));
}

export async function ageZzStalledProjects(projects: ZzProject[], at: Date) {
  await verifyZzProjects(projects);
  const ids = projects.map((project) => project.id);
  await db.$transaction([
    db.project.updateMany({ where: { id: { in: ids } }, data: { createdAt: at, stageChangedAt: at } }),
    db.task.updateMany({ where: { projectId: { in: ids } }, data: { updatedAt: at } }),
    db.actionLog.updateMany({ where: { projectId: { in: ids } }, data: { createdAt: at } }),
  ]);
}

export async function clearZzNotifications(people: ZzPerson[]) {
  await verifyZzPeople(people);
  await db.notification.deleteMany({ where: { recipientId: { in: people.map((person) => person.id) } } });
}
