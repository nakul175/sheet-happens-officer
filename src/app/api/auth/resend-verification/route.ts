import { db } from "@/lib/db";
import { emailLimitReached, issueToken } from "@/lib/auth";
import { MailError, RESEND_FAILED, sendMail, verifyMail } from "@/lib/email";
import { ApiError, handle, parseBody } from "@/lib/http";
import { resendInput } from "@/lib/schemas";

// SHO-US-1.2 AC3/AC4. One neutral answer for every case, so it never reveals whether an
// address has an account, is already verified, or has hit the limit of 3 per hour.
// APL-2742: the one exception is a send the provider refused, which answers 503 so the person is not told it went.
export const POST = handle(async (req: Request) => {
  const { email } = await parseBody(req, resendInput);
  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.emailVerifiedAt && !user.deactivatedAt && !(await emailLimitReached(user.id, "VERIFY"))) {
    try {
      await sendMail(verifyMail(email, await issueToken(user.id, "VERIFY")));
    } catch (err) {
      if (err instanceof MailError) throw new ApiError(503, RESEND_FAILED);
      throw err;
    }
  }
  return Response.json({
    status: "ok",
    message: "If this address needs a new link, it has been sent. You can ask up to 3 times an hour; if you have asked that often already, try again later.",
  });
});
