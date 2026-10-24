// APL-2742. Texts shown on the verification failure paths. Plain strings with no server imports, so the API routes and
// the client screens use the same words. Each one must stay true whatever happened to the email.

/** Sign-up created the account but the verification email did not go. */
export const VERIFY_SEND_FAILED =
  'We created your account but could not send the verification email. Use "resend the link" below in a few minutes; if it still does not arrive, contact your Super Admin.';

/** The one answer to every resend request: sent, failed, limited or unknown address alike. It never says an email went. */
export const RESEND_NOTICE =
  "Request received. If this address has an account waiting for verification, and it has not reached the limit of 3 requests an hour, we will try to email it a new link. If nothing arrives within a few minutes, check spam, then try again later.";

/** Sign-in refused for an unverified account. Does not assume a link ever reached the person. */
export const UNVERIFIED_SIGNIN = "Verify your email before you sign in. No working verification link? Use Resend link.";

/** The verify API's answer for a token that is unknown, expired, already used or replaced. */
export const VERIFY_LINK_UNUSABLE = "This link is invalid, has expired, was already used or was replaced by a newer one.";

/**
 * SHO-2695. The machine-readable code on the SHO-US-23.5 forced-password 403, next to the sentence
 * "Set your own password first." Clients route on this, never on the sentence, so the sentence can be reworded.
 * Plain string with no server imports, so a client screen and the API route share one definition.
 */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";
