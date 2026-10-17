import { z } from "zod";

// Domain rule: exactly aplyd.com, checked on the server (SHO-US-1.1 AC2).
export const ALLOWED_DOMAIN = "aplyd.com";
export const DOMAIN_MESSAGE = "Use your @aplyd.com email address.";
export const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine((e) => e.slice(e.lastIndexOf("@") + 1) === ALLOWED_DOMAIN, { message: DOMAIN_MESSAGE });

// Max 128 so a huge password cannot be used to burn CPU in the hash.
export const passwordField = z
  .string()
  .min(8, PASSWORD_MESSAGE)
  .max(128, PASSWORD_MESSAGE)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), { message: PASSWORD_MESSAGE });

export const signUpInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailField,
  password: passwordField,
});

// Sign-in does not apply the domain rule: a wrong-domain email must look like any other failure.
export const signInInput = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(128),
});

export const tokenInput = z.object({ token: z.string().min(20).max(200) });

export const resendInput = z.object({ email: emailField });

export const resetInput = z
  .object({ token: z.string().min(20).max(200), password: passwordField, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match.", path: ["confirm"] });
