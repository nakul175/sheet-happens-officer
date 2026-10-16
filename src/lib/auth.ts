import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";

// Deliberately minimal: identity by email, tracked in an httpOnly cookie.
// No passwords and no tenant enforcement yet (explicit scope decision).
// Replace this module with real auth (e.g. SSO/magic links) before exposing outside the team.
export const SESSION_COOKIE = "tb_uid";

export async function currentUser() {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (!id) throw new ApiError(401, "Not signed in");
  const user = await db.user.findUnique({ where: { id } });
  if (!user) throw new ApiError(401, "Not signed in");
  return user;
}
