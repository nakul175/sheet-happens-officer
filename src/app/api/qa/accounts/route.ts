import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { isZzTestAddress, qaToken, sinkMode, tokensEqual } from "@/lib/mail-sink";

const noStore = { "cache-control": "no-store" };
const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: noStore });

type QaAccount = { email?: unknown; password?: unknown; role?: unknown; name?: unknown };

function validPassword(value: string): boolean {
  return value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/**
 * Resets at most two isolated ZZ fixtures before a staging shard runs. The route is
 * absent unless the mail sink's complete staging guard is active, so production
 * cannot expose or execute this path.
 */
export async function POST(req: Request): Promise<Response> {
  const mode = sinkMode();
  if (!mode.active) return notFound();
  if (!tokensEqual(qaToken(req.headers.get("x-qa-token")), mode.token)) {
    return Response.json({ error: "Not allowed" }, { status: 401, headers: noStore });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: noStore });
  }
  const accounts = (raw as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 2) {
    return Response.json({ error: "accounts must contain one or two fixtures" }, { status: 400, headers: noStore });
  }

  const parsed = accounts.map((row: QaAccount) => ({
    email: typeof row?.email === "string" ? row.email.trim().toLowerCase() : "",
    password: typeof row?.password === "string" ? row.password : "",
    role: row?.role,
    name: typeof row?.name === "string" ? row.name.trim().slice(0, 120) : "",
  }));
  if (new Set(parsed.map((row) => row.email)).size !== parsed.length) {
    return Response.json({ error: "fixture emails must be unique" }, { status: 400, headers: noStore });
  }
  if (parsed.some((row) => !isZzTestAddress(row.email))) {
    return Response.json({ error: "fixtures must use ZZ test addresses" }, { status: 400, headers: noStore });
  }
  if (parsed.some((row) => row.role !== "ADMIN" && row.role !== "MEMBER")) {
    return Response.json({ error: "role must be ADMIN or MEMBER" }, { status: 400, headers: noStore });
  }
  if (parsed.some((row) => !validPassword(row.password))) {
    return Response.json({ error: "password must have at least 8 characters, a letter and a digit" }, { status: 400, headers: noStore });
  }

  const workspace = await db.workspace.findFirst({ select: { id: true } });
  if (!workspace) return Response.json({ error: "No test workspace" }, { status: 409, headers: noStore });

  const prepared = await Promise.all(parsed.map(async (row) => ({ ...row, passwordHash: await hashPassword(row.password) })));
  await db.$transaction(async (tx) => {
    for (const row of prepared) {
      const user = await tx.user.upsert({
        where: { email: row.email },
        create: {
          workspaceId: workspace.id,
          email: row.email,
          name: row.name || (row.role === "ADMIN" ? "ZZ Test Admin" : "ZZ Test Member"),
          passwordHash: row.passwordHash,
          emailVerifiedAt: new Date(),
          orgRole: row.role === "ADMIN" ? "SUPER_ADMIN" : "MEMBER",
        },
        update: {
          passwordHash: row.passwordHash,
          emailVerifiedAt: new Date(),
          deactivatedAt: null,
          tempPasswordAt: null,
          orgRole: row.role === "ADMIN" ? "SUPER_ADMIN" : "MEMBER",
        },
        select: { id: true },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.authToken.deleteMany({ where: { userId: user.id } });
      await tx.loginAttempt.deleteMany({ where: { email: row.email } });
    }
  });

  return Response.json({ ok: true, count: prepared.length }, { headers: noStore });
}
