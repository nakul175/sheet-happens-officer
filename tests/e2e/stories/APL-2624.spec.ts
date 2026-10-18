// SHO-US-23.5 Temporary password must be changed at first sign-in (Linear APL-2624, PR #8). Acceptance criteria AC1 to AC7.
// The emailed password is only ever in the person's inbox, and staging has no mailbox a test can read, so every check that signs in
// with an emailed password is skipped here and covered by tests/forced-password-23-5.test.ts (vitest, local outbox).
// Staging runs main, where PR #8 is not merged: checks of the new behaviour are skipped until it is.
import { test, expect } from "../support";
import { why } from "../helpers/jim-http";

const NOT_MERGED = "Needs PR #8 (SHO-US-23.5) merged to main and deployed to staging.";
const NO_MAILBOX = "Needs the emailed password; staging has no mailbox a test can read. Covered by tests/forced-password-23-5.test.ts.";

test.describe("SHO-US-23.5 / APL-2624", () => {
  test.skip("AC1: after signing in with a Super-Admin-issued password, every screen but 'Set your own password' and sign-out is blocked", why(`${NO_MAILBOX} ${NOT_MERGED}`), async () => {
    // By hand after the merge: Add person, sign in with the emailed password, open /, /projects, /team, /profile and /search;
    // each shows only "Set your own password" with Sign out and no Main navigation.
  });

  test.skip("AC2: a new password that meets the rules opens the asked-for page, clears the forced state, and the emailed password stops working", why(`${NO_MAILBOX} ${NOT_MERGED}`), async () => {
  });

  test.skip("AC3: a new password equal to the emailed one is refused with 'Choose a new password. It cannot be the one we emailed you.'", why(`${NO_MAILBOX} ${NOT_MERGED}`), async () => {
  });

  test.skip("AC4: in the forced state every app API but change-password, sign-out and me answers 403 PASSWORD_CHANGE_REQUIRED", why(`${NO_MAILBOX} ${NOT_MERGED}`), async () => {
  });

  test.skip("AC5: Resend sign-in details puts the person back in the forced state for the new password", why(`${NO_MAILBOX} ${NOT_MERGED}`), async () => {
  });

  test("AC6 (own password): a person who set their own password is never forced", async ({ admin }) => {
    // Runs on main as a guard: the Super Admin signed in with their own password reaches every screen and API.
    const me = await admin.api.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword ?? false).toBe(false); // the field exists once PR #8 is merged
    for (const p of ["/api/projects", "/api/my-tasks", "/api/team"]) expect((await admin.api.get(p)).status, p).toBe(200);
    for (const url of ["/", "/projects", "/profile"]) {
      await admin.page.goto(url);
      await expect(admin.page.locator('[aria-label="Main"]:visible').first(), url).toBeVisible(); // side menu on desktop, tab bar on a phone
      await expect(admin.page.getByRole("heading", { name: "Set your own password" }), url).toHaveCount(0);
    }
  });

  test.skip("AC6 (Forgot password): a person who reset their password by email is never forced", why(NO_MAILBOX), async () => {
  });

  test.skip("AC7 (Add person): the dialog says the person must replace the password at first sign-in, not that it stays valid", why(NOT_MERGED), async ({ admin }) => {
    await admin.page.goto("/team");
    await admin.page.getByRole("button", { name: /Add person/ }).click();
    const dlg = admin.page.getByRole("dialog");
    await expect(dlg).toContainText("The person must replace it with their own when they first sign in.");
    await expect(dlg).not.toContainText(/stays valid/i);
    await dlg.getByRole("button", { name: "Cancel" }).click();
  });

  test.skip("AC7 (email and banner): the email says the password is temporary and the closable banner is gone", why(`${NO_MAILBOX} ${NOT_MERGED}`), async () => {
  });
});

