import { createServer, type Server } from "node:http";
import { db } from "../src/lib/db";

type SeedPerson = { id: string; email: string; name: string };
type SeedProject = { id: string; name: string };
type Notice = {
  recipientId: string;
  type: string;
  projectId: string;
  taskId?: string;
  data: Record<string, string | undefined>;
};

function assertLocalDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required for the CRM fixture API");
  const host = new URL(raw.replace(/^postgres(ql)?:/i, "http:")).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Refusing CRM fixture writes outside the local test database");
  }
}

async function verifyFixture(people: SeedPerson[], projects: SeedProject[]) {
  assertLocalDatabase();
  if (people.some((p) => !p.name.toLowerCase().includes("zz-test") || !p.email.includes("@aplyd.com"))) {
    throw new Error("Refusing non-ZZ-TEST people");
  }
  if (projects.some((p) => !p.name.toLowerCase().includes("zz-test"))) {
    throw new Error("Refusing non-ZZ-TEST projects");
  }
  const [storedPeople, storedProjects] = await Promise.all([
    db.user.findMany({ where: { id: { in: people.map((p) => p.id) } }, select: { id: true, email: true, name: true } }),
    db.project.findMany({ where: { id: { in: projects.map((p) => p.id) } }, select: { id: true, name: true } }),
  ]);
  const peopleById = new Map(storedPeople.map((p) => [p.id, p]));
  const projectsById = new Map(storedProjects.map((p) => [p.id, p]));
  for (const person of people) {
    const stored = peopleById.get(person.id);
    if (!stored || stored.email !== person.email || stored.name !== person.name) throw new Error(`Unverified ZZ-TEST person ${person.id}`);
  }
  for (const project of projects) {
    if (projectsById.get(project.id)?.name !== project.name) throw new Error(`Unverified ZZ-TEST project ${project.id}`);
  }
}

/**
 * Loopback-only HTTP boundary for the exact synthetic bell rows the CRM mode test needs.
 * Product setup still uses the real application APIs. Keeping this mutation behind an
 * explicit local API makes accidental staging/production writes impossible and keeps the
 * mode spec itself free of direct database writes.
 */
export async function startCrmModeSeedApi() {
  const token = crypto.randomUUID();
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::1") throw new Error("Loopback only");
      if (req.method !== "POST" || req.url !== "/replace-notifications" || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        people: SeedPerson[];
        projects: SeedProject[];
        notices: Notice[];
      };
      await verifyFixture(body.people, body.projects);
      const personIds = new Set(body.people.map((p) => p.id));
      const projectIds = new Set(body.projects.map((p) => p.id));
      if (body.notices.some((n) => !personIds.has(n.recipientId) || !projectIds.has(n.projectId))) {
        throw new Error("Notice is outside the verified ZZ-TEST fixture");
      }
      await db.$transaction([
        db.notification.deleteMany({ where: { recipientId: { in: [...personIds] } } }),
        db.notification.createMany({
          data: body.notices.map((notice) => ({
            ...notice,
            data: Object.fromEntries(Object.entries(notice.data).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          })),
        }),
      ]);
      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(400, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : "fixture error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CRM fixture API did not bind");
  return {
    replaceNotifications: async (body: { people: SeedPerson[]; projects: SeedProject[]; notices: Notice[] }) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/replace-notifications`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`CRM fixture API ${response.status}: ${await response.text()}`);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
