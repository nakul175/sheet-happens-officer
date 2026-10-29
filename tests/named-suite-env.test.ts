import { afterEach, describe, expect, it, vi } from "vitest";
import { namedSuiteEnv } from "./e2e/helpers/named-suite";

afterEach(() => vi.unstubAllEnvs());

function configure() {
  vi.stubEnv("SHO_NAMED_SUITE_DATABASE_URL", "postgresql://synthetic:synthetic@127.0.0.1:55515/sho_e4_named");
  vi.stubEnv("SHO_NAMED_SUITE_BASE_URL", "http://127.0.0.1:3420");
  vi.stubEnv("SHO_NAMED_SUITE_EMAIL_OUTBOX_DIR", "/tmp/zz-test-named-outbox");
}

describe("named suite environment boundaries", () => {
  it("selects the dedicated loopback server and DB, removing provider and sign-in secrets", () => {
    configure();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-provider-value");
    vi.stubEnv("SHO_ADMIN_PASS", "synthetic-password-value");
    vi.stubEnv("SESSION_COOKIE", "synthetic-cookie-value");
    const env = namedSuiteEnv();
    expect(env.DATABASE_URL).toContain("/sho_e4_named");
    expect(env.TASKBOARD_URL).toBe("http://127.0.0.1:3420");
    expect(env.APP_URL).toBe(env.TASKBOARD_URL);
    expect(env.BASE_URL).toBe(env.TASKBOARD_URL);
    expect(env.EMAIL_OUTBOX_DIR).toBe("/tmp/zz-test-named-outbox");
    for (const key of ["ANTHROPIC_API_KEY", "SHO_ADMIN_PASS", "SESSION_COOKIE", "SHO_NAMED_SUITE_DATABASE_URL"]) expect(env[key]).toBeUndefined();
  });

  it("accepts localhost as a loopback origin", () => {
    configure();
    vi.stubEnv("SHO_NAMED_SUITE_BASE_URL", "https://localhost:3420");
    expect(namedSuiteEnv().TASKBOARD_URL).toBe("https://localhost:3420");
  });

  it("validates explicit targets even when the default named target is safe", () => {
    configure();
    expect(() => namedSuiteEnv({ databaseUrl: "postgresql://server.invalid/taskboard" })).toThrow("non-local database");
    expect(() => namedSuiteEnv({ baseUrl: "https://server.invalid" })).toThrow("loopback origin");
    const env = namedSuiteEnv({ databaseUrl: "postgresql://127.0.0.1/zz_test", baseUrl: "http://localhost:3422", outboxDir: "/tmp/zz-test-primary-outbox" });
    expect(env.DATABASE_URL).toBe("postgresql://127.0.0.1/zz_test");
    expect(env.TASKBOARD_URL).toBe("http://localhost:3422");
    expect(env.EMAIL_OUTBOX_DIR).toBe("/tmp/zz-test-primary-outbox");
  });

  it.each(["postgresql://synthetic:synthetic@database.invalid/taskboard", "mysql://127.0.0.1/taskboard", "invalid-db"])("refuses a non-local or invalid database", db => {
    configure();
    vi.stubEnv("SHO_NAMED_SUITE_DATABASE_URL", db);
    expect(() => namedSuiteEnv()).toThrow("non-local database");
  });

  it.each(["https://server.invalid", "http://synthetic:synthetic@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/?token=synthetic", "invalid-url"])("refuses remote, credentialed or non-origin server URLs without echoing input", url => {
    configure();
    vi.stubEnv("SHO_NAMED_SUITE_BASE_URL", url);
    expect(() => namedSuiteEnv()).toThrow(/^Refusing a named-suite server URL that is not a loopback origin\.$/);
  });
});
