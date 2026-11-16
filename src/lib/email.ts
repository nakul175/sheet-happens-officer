import { INSTALL_GUIDANCE } from "./install-guidance";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deliverSinkMail } from "./mail-sink";

export type Mail = { to: string; subject: string; text: string };

// APL-2929: the sender stays on the old domain until Resend verifies sheethappensofficer.aplyd.org.
const FROM = process.env.EMAIL_FROM ?? "Sheet Happens Officer <no-reply@sheethappensofficer.com>";

/** The provider refused or could not be reached. Carries only the HTTP status and Resend's error name. */
export class MailError extends Error {
  constructor(message: string, public status?: number, public providerName?: string) {
    super(message);
    this.name = "MailError";
  }
}

/** Keep only a bounded error category in the exception; provider response text is untrusted. */
async function resendError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { name?: unknown };
    return typeof body.name === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(body.name) ? body.name : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Sends through Resend when RESEND_API_KEY is set (production).
 * Without a key, outside production, mail is written to a local outbox folder so
 * development and tests can read the links. In production a missing key is an error.
 * Failures log only a fixed label and HTTP status. Provider/transport text and mail fields may
 * echo a recipient, sign-in link or credential, so none of them are logged.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (process.env.MAIL_SINK) {
    await deliverSinkMail(mail, FROM);
    return;
  }
  const key = process.env.RESEND_API_KEY;
  if (key) {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
    } catch {
      console.error("[mail] could not reach Resend");
      throw new MailError("Could not reach Resend");
    }
    if (!res.ok) {
      const name = await resendError(res);
      console.error(`[mail] Resend rejected: HTTP ${res.status}`);
      throw new MailError(`Resend rejected the email (HTTP ${res.status})`, res.status, name);
    }
    return;
  }
  // The outbox is for development and CI only; production must name a key unless an outbox folder is set on purpose.
  if (process.env.NODE_ENV === "production" && !process.env.EMAIL_OUTBOX_DIR) {
    console.error("[mail] not sent: RESEND_API_KEY is not set");
    throw new MailError("RESEND_API_KEY is not set");
  }
  const dir = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await writeFile(path.join(dir, name), JSON.stringify({ ...mail, from: FROM }, null, 2));
}

export { VERIFY_SEND_FAILED } from "./auth-messages";

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const verifyMail = (to: string, token: string): Mail => ({
  to,
  subject: "Verify your email for Sheet Happens Officer",
  text: `Confirm your email to finish creating your account:\n\n${appUrl()}/verify?token=${token}\n\nThis link works once and expires in 24 hours. If you did not sign up, ignore this email.`,
});

export const resetMail = (to: string, token: string): Mail => ({
  to,
  subject: "Reset your Sheet Happens Officer password",
  text: `Set a new password:\n\n${appUrl()}/reset?token=${token}\n\nThis link works once and expires in 1 hour. If you did not ask for this, ignore this email.`,
});

/** SHO-US-15.3. The one place a generated password is written into an email. Never logged or audited. */
export const signInDetailsMail = (to: string, firstName: string, addedBy: string, password: string): Mail => ({
  to,
  subject: "Your Sheet Happens Officer account",
  text: `Hi ${firstName},\n\n${addedBy} added you to Sheet Happens Officer. Sign in here:\n\n${appUrl()}/signin\n\nUsername: ${to}\nPassword: ${password}\n\nThis password is temporary. When you sign in, you will be asked to set your own password before you can do anything else. After that, this one stops working.\n\n${INSTALL_GUIDANCE}\n\nIf you did not expect this email, ignore it and tell ${addedBy}. Do not forward this email, because it contains your password.`,
});
