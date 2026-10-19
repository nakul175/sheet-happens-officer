import { db } from "@/lib/db";
import { audit, hashPassword, issueToken, superAdminEmails } from "@/lib/auth";
import { MailError, VERIFY_SEND_FAILED, sendMail, verifyMail } from "@/lib/email";
import { ApiError, handle, parseBody } from "@/lib/http";
import { signUpInput } from "@/lib/schemas";

// SHO-US-1.1. Creates an unverified account and emails a link. Never signs the person in.
export const POST = handle(async (req: Request) => {
  const { name, email, password } = await parseBody(req, signUpInput);
  if (await db.user.findUnique({ where: { email } })) {
    throw new ApiError(409, "An account with this email already exists.");
  }
  const workspace =
    (await db.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await db.workspace.create({ data: { name: "Workspace" } }));
  const user = await db.user.create({
    data: {
      workspaceId: workspace.id,
      email,
      name,
      passwordHash: await hashPassword(password),
      // First Super Admin comes from server config only (SHO-US-2.1).
      orgRole: superAdminEmails().includes(email) ? "SUPER_ADMIN" : "MEMBER",
    },
  });
  await audit("ACCOUNT_CREATED", { actorId: user.id });
  try {
    await sendMail(verifyMail(email, await issueToken(user.id, "VERIFY")));
  } catch (err) {
    // APL-2742: the account exists either way; say the email did not go so the person can resend it, instead of a 500.
    if (!(err instanceof MailError)) throw err;
    return Response.json({ status: "check_email", emailSent: false, message: VERIFY_SEND_FAILED }, { status: 201 });
  }
  return Response.json({ status: "check_email", emailSent: true }, { status: 201 });
});
