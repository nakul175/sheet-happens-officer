import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deliverSinkMail } from "@/lib/mail-sink";

export type Mail = { to: string; subject: string; text: string };

const FROM = process.env.EMAIL_FROM ?? "Sheet Happens Officer <no-reply@sheethappensofficer.com>";

/**
 * Sends through Resend when RESEND_API_KEY is set (production).
 * Without a key, outside production, mail is written to a local outbox folder so
 * development and tests can read the links. In production a missing key is an error.
 *
 * MAIL_SINK is off unless it is exactly "staging" on a staging host with a token and
 * an outbox directory (APL-2681). Any other value refuses to send or store, and never
 * falls through to Resend or the development outbox.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (process.env.MAIL_SINK) {
    await deliverSinkMail(mail, FROM);
    return;
  }
  const key = process.env.RESEND_API_KEY;
  if (key) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend rejected the email (HTTP ${res.status})`);
    return;
  }
  // The outbox is for development and CI only; production must name a key unless an outbox folder is set on purpose.
  if (process.env.NODE_ENV === "production" && !process.env.EMAIL_OUTBOX_DIR) throw new Error("RESEND_API_KEY is not set");
  const dir = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await writeFile(path.join(dir, name), JSON.stringify({ ...mail, from: FROM }, null, 2));
}

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
