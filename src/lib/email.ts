import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type Mail = { to: string; subject: string; text: string };

const FROM = process.env.EMAIL_FROM ?? "Sheet Happens Officer <no-reply@sheethappensofficer.com>";

/** The provider refused or could not be reached. Carries only the HTTP status and Resend's error name. */
export class MailError extends Error {
  constructor(message: string, public status?: number, public providerName?: string) {
    super(message);
    this.name = "MailError";
  }
}

// One line, bounded: Resend's message names the problem (e.g. an unverified domain) but is still provider text.
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

/** Resend's error body is {statusCode, name, message}; anything else (an HTML gateway page) is not logged. */
async function resendError(res: Response): Promise<{ name: string; message: string }> {
  try {
    const body = (await res.json()) as { name?: unknown; message?: unknown };
    return { name: oneLine(body.name) || "unknown", message: oneLine(body.message) || "no message" };
  } catch {
    return { name: "unknown", message: "the response was not JSON" };
  }
}

/**
 * Sends through Resend when RESEND_API_KEY is set (production).
 * Without a key, outside production, mail is written to a local outbox folder so
 * development and tests can read the links. In production a missing key is an error.
 * Every failure is logged (APL-2742) with the subject, the HTTP status and Resend's error name and message:
 * never the key, the recipient or the body, which can hold a sign-in link or a password.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (key) {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
    } catch (err) {
      console.error(`[mail] could not reach Resend for "${mail.subject}": ${oneLine((err as Error)?.message)}`);
      throw new MailError("Could not reach Resend");
    }
    if (!res.ok) {
      const { name, message } = await resendError(res);
      console.error(`[mail] Resend rejected "${mail.subject}": HTTP ${res.status} ${name}: ${message}`);
      throw new MailError(`Resend rejected the email (HTTP ${res.status})`, res.status, name);
    }
    return;
  }
  // The outbox is for development and CI only; production must name a key unless an outbox folder is set on purpose.
  if (process.env.NODE_ENV === "production" && !process.env.EMAIL_OUTBOX_DIR) {
    console.error(`[mail] not sent "${mail.subject}": RESEND_API_KEY is not set`);
    throw new MailError("RESEND_API_KEY is not set");
  }
  const dir = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await writeFile(path.join(dir, name), JSON.stringify({ ...mail, from: FROM }, null, 2));
}

/** APL-2742. What the person sees when the verification email could not be sent. */
export const VERIFY_SEND_FAILED = "We created your account but could not send the verification email. Use Resend below in a few minutes; if it still does not arrive, contact your Super Admin.";
export const RESEND_FAILED = "We could not send the email just now. Wait a few minutes, then try again.";

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
  text: `Hi ${firstName},\n\n${addedBy} added you to Sheet Happens Officer. Sign in here:\n\n${appUrl()}/signin\n\nUsername: ${to}\nPassword: ${password}\n\nThis password stays valid until you change it. We suggest you set your own after you sign in: open Profile, then Change password.\n\nIf you did not expect this email, ignore it and tell ${addedBy}. Do not forward this email, because it contains your password.`,
});
