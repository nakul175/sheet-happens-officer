import { db } from "@/lib/db";
import { AuthMailLimitError, emailLimitReached, issueTokenAndSend } from "@/lib/auth";
import { MailError, resetMail, sendMail } from "@/lib/email";
import { handle, parseBody } from "@/lib/http";
import { resendInput } from "@/lib/schemas";

// SHO-US-1.4 AC1/AC5. The response is identical whether or not the address has an account.
export const POST = handle(async (req: Request) => {
  const { email } = await parseBody(req, resendInput);
  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.deactivatedAt && !(await emailLimitReached(user.id, "RESET"))) {
    try { await issueTokenAndSend(user.id, "RESET", (token) => sendMail(resetMail(email, token))); }
    // A provider outage must not reveal whether this address has an account.
    // sendMail records the redacted provider failure; unexpected DB errors still fail.
    catch (err) { if (!(err instanceof AuthMailLimitError) && !(err instanceof MailError)) throw err; }
  }
  return Response.json({
    status: "ok",
    message: "If an account exists for this address, a reset link is on its way. You can ask up to 3 times an hour; if you have asked that often already, try again later.",
  });
});
