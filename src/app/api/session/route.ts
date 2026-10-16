import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { SESSION_COOKIE, currentUser } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { sessionInput } from "@/lib/schemas";

// Sign in (or first-time sign up) by email. Single shared workspace for now.
export const POST = handle(async (req: Request) => {
  const { email, name } = await parseBody(req, sessionInput);

  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    if (!name) throw new ApiError(400, "name is required for a new user");
    const workspace =
      (await db.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ??
      (await db.workspace.create({ data: { name: "Workspace" } }));
    user = await db.user.create({ data: { email, name, workspaceId: workspace.id } });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, user.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === "production",
  });
  return Response.json({ user }, { status: 200 });
});

export const GET = handle(async () => {
  return Response.json({ user: await currentUser() });
});

export const DELETE = handle(async () => {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return new Response(null, { status: 204 });
});
