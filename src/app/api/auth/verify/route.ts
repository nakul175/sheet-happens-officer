import { db } from "@/lib/db";
import { consumeToken } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { tokenInput } from "@/lib/schemas";

// SHO-US-1.2. Single use, 24 hours. Verifying does not sign the person in.
export const POST = handle(async (req: Request) => {
  const { token } = await parseBody(req, tokenInput);
  const userId = await consumeToken(token, "VERIFY");
  if (!userId) throw new ApiError(400, "This link has expired or was already used.");
  await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  return Response.json({ status: "verified" });
});
