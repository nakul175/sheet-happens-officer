import { db } from "@/lib/db";
import { audit, clientAgent, clientIp, consumeToken } from "@/lib/auth";
import { ApiError, handle, parseBody } from "@/lib/http";
import { tokenInput } from "@/lib/schemas";

// SHO-US-1.2. Single use, 24 hours. Verifying does not sign the person in.
// APL-2742: only a click on /verify posts here (a link scanner's GET does not), and the audit row keeps the IP and user agent.
export const POST = handle(async (req: Request) => {
  const { token } = await parseBody(req, tokenInput);
  const userId = await consumeToken(token, "VERIFY");
  if (!userId) throw new ApiError(400, "This link has expired or was already used.");
  await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const ua = clientAgent(req);
  await audit("EMAIL_VERIFIED", { actorId: userId, ip: clientIp(req), data: ua ? { userAgent: ua } : undefined });
  return Response.json({ status: "verified" });
});
