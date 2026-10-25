import { expect, it } from "vitest";
import { assertCreationCompatTarget } from "./future-feature-creation-target";
const base = "http://localhost:3480";
const raw = "postgresql://synthetic:synthetic@127.0.0.1:55432/sho_test?schema=sho_future_features_20261024";
it("allows only the recorded owned local schemas", () => {
 expect(() => assertCreationCompatTarget({ DATABASE_URL: raw }, base)).not.toThrow();
 expect(() => assertCreationCompatTarget({ DATABASE_URL: raw.replace("sho_future_features_20261024", "sho_future_ci_browser_20261024") }, base)).not.toThrow();
});
it("allows the explicit GitHub Actions CI schema on loopback sho_test", () => {
 expect(() => assertCreationCompatTarget({ DATABASE_URL: raw.replace("sho_future_features_20261024", "sho_ci"), GITHUB_ACTIONS: "true", CI: "true" }, base)).not.toThrow();
});
it.each([
 {}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "false", GITHUB_ACTIONS: "true" },
])("rejects the CI schema without both exact CI signals", flags => {
 expect(() => assertCreationCompatTarget({ DATABASE_URL: raw.replace("sho_future_features_20261024", "sho_ci"), ...flags }, base)).toThrow(/Refusing nonowned/);
});
it.each([
 raw.replace("127.0.0.1", "remote.example.com"), raw.replace("/sho_test?", "/production?"),
 raw.replace("sho_future_features_20261024", "public"), raw.replace("sho_future_features_20261024", "sho_other_project"),
 raw + "&schema=public", raw + "&host=remote.example.com", raw + "&hostaddr=10.0.0.1", raw + "&dbname=production", raw + "&options=-csearch_path=public",
])("rejects remote/shared/overridden database targets even with CI flags", value => {
 expect(() => assertCreationCompatTarget({ DATABASE_URL: value, CI: "true", GITHUB_ACTIONS: "true" }, base)).toThrow(/Refusing nonowned/);
});
it.each(["https://app.example.com", "http://remote.example.com", "http://user:secret@localhost:3480"])("rejects nonowned app target %s", value => {
 expect(() => assertCreationCompatTarget({ DATABASE_URL: raw }, value)).toThrow(/Refusing nonowned/);
});
