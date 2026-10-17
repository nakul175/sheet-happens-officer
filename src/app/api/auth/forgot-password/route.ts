import { db } from "@/lib/db";
import { emailLimitReached, issueToken } from "@/lib/auth";
import { resetMail, sendMail } from "@/lib/email";
import { handle, parseBody } from "@/lib/http";
import { resendInput } from "@/lib/schemas";

// SHO-US-1.4 AC1/AC5. The response is identical whether or not the address has an account.
export const POST = handle(async (req: Request) => {
  const { email } = await parseBody(req, resendInput);
  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.deactivatedAt && !(await emailLimitReached(user.id, "RESET"))) {
    await sendMail(resetMail(email, await issueToken(user.id, "RESET")));
  }
  return Response.json({
    status: "ok",
    message: "If an account exists for this address, a reset link is on its way.",
  });
});
