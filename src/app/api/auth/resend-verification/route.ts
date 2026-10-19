import { db } from "@/lib/db";
import { MAX_EMAILS_PER_HOUR, audit, clientAgent, clientIp, emailLimitReached, issueTokenAndSend } from "@/lib/auth";
import { MailError, sendMail, verifyMail } from "@/lib/email";
import { handle, parseBody } from "@/lib/http";
import { resendInput } from "@/lib/schemas";

const EVENT = "VERIFY_EMAIL_REQUESTED";
const HOUR = 3600_000;

// SHO-US-1.2 AC3/AC4. One neutral answer for every case, so it never reveals whether an address has an account, is
// already verified, has hit the limit of 3 per hour, or could not be sent to (APL-2742 D4). The answer never says
// the email went.
// APL-2742: a failed send keeps the link already delivered working and does not count toward the limit (D1); failed
// attempts have their own cap of 3 an hour, so a client cannot hammer the provider while it is refusing.
// Each request for an unverified, active account is audited with the IP, user agent and result (never the address),
// except that only the first LIMITED row in an hour is written (D6). An unknown or verified address leaves no row.
export const POST = handle(async (req: Request) => {
  const { email } = await parseBody(req, resendInput);
  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.emailVerifiedAt && !user.deactivatedAt) {
    const ua = clientAgent(req);
    const record = (result: "SENT" | "LIMITED" | "FAILED") =>
      audit(EVENT, { actorId: user.id, ip: clientIp(req), data: { result, ...(ua ? { userAgent: ua } : {}) } });
    const lastHour = (result: string) =>
      db.auditLog.count({ where: { actorId: user.id, event: EVENT, createdAt: { gt: new Date(Date.now() - HOUR) }, data: { path: ["result"], equals: result } } });
    if ((await emailLimitReached(user.id, "VERIFY")) || (await lastHour("FAILED")) >= MAX_EMAILS_PER_HOUR) {
      if ((await lastHour("LIMITED")) === 0) await record("LIMITED");
    } else {
      try {
        await issueTokenAndSend(user.id, "VERIFY", (token) => sendMail(verifyMail(email, token)));
        await record("SENT");
      } catch (err) {
        if (!(err instanceof MailError)) throw err;
        await record("FAILED"); // logged by sendMail; the person gets the same neutral answer
      }
    }
  }
  return Response.json({
    status: "ok",
    message: "If this address needs a new link, we are sending one. If nothing arrives in a few minutes, check spam or ask again; you can ask up to 3 times an hour.",
  });
});
