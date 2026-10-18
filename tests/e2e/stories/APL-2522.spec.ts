// APL-2522 (SHO-US-4.6). Starting this spec runs the prod guard before any test.
// The guard reads BASE_URL from process start because Vitest rewrites the live value to "/".
import { BASE_URL } from "../base-url";
import { expect, it } from "vitest";

it("the APL-2522 spec started against a non-production target", () => {
  expect(new URL(BASE_URL).protocol).toMatch(/^https?:$/);
});
