import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type Mail = { to: string; subject: string; text: string };

const FROM = process.env.EMAIL_FROM ?? "Sheet Happens Officer <no-reply@sheethappensofficer.com>";

/**
 * Sends through Resend when RESEND_API_KEY is set (production).
 * Without a key, outside production, mail is written to a local outbox folder so
 * development and tests can read the links. In production a missing key is an error.
 */
export async function sendMail(mail: Mail): Promise<void> {
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
  if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is not set");
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
