import { db } from "@/lib/db";
import { emailLimitReached, issueToken } from "@/lib/auth";
import { sendMail, verifyMail } from "@/lib/email";
import { handle, parseBody } from "@/lib/http";
import { resendInput } from "@/lib/schemas";

// SHO-US-1.2 AC3/AC4. One neutral answer for every case, so it never reveals whether an
// address has an account, is already verified, or has hit the limit of 3 per hour.
export const POST = handle(async (req: Request) => {
  const { email } = await parseBody(req, resendInput);
  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.emailVerifiedAt && !user.deactivatedAt && !(await emailLimitReached(user.id, "VERIFY"))) {
    await sendMail(verifyMail(email, await issueToken(user.id, "VERIFY")));
  }
  return Response.json({
    status: "ok",
    message: "If this address needs a new link, it has been sent. You can ask up to 3 times an hour; if you have asked that often already, try again later.",
  });
});
