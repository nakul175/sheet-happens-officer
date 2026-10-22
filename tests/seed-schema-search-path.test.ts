// APL-2590 D1: why seed-apl2590-fixtures.ts checks ?schema= itself instead of trusting the connection string.
// Prisma's client/CLI read the ?schema= query param and set search_path. A plain `pg` connection does not: it parses
// only pg's own parameters and ignores ?schema=, so a raw-SQL path keeps the default search_path and can silently
// write into public. Hermetic: no server, no network. Client construction parses the URL only, it never connects.
import { Client } from "pg";
import { describe, expect, it } from "vitest";

/** pg attaches the parsed connection parameters to the client but does not declare them in its types. */
type PgClient = Client & { connectionParameters: Record<string, unknown> };

const PW = "s3cretDbPw9";
const url = (query: string) => `postgresql://sho_pr_user:${PW}@private-sho-db-do-user-45345612-0.k.db.ondigitalocean.com:25060/sho_staging${query}`;

/** The parameters pg keeps for a given connection string. Nothing here opens a socket. */
function params(query: string) {
  const c = new Client({ connectionString: url(query) }) as PgClient;
  return { client: c, p: c.connectionParameters };
}

describe("qa:TC missing APL-2590 D1: ?schema= is a Prisma parameter, not a pg one", () => {
  it("qa:TC missing: a plain pg connection drops ?schema=, so search_path stays the server default", () => {
    const { p } = params("?schema=sho_pr1");
    // pg has no notion of a schema: the one key Prisma would act on is simply absent from its parameters.
    expect(p).not.toHaveProperty("schema");
    expect(Object.keys(p)).not.toContain("searchPath");
    // With no options=, pg sends no start-up option, so search_path is whatever the role/server defaults to ("$user", public).
    expect(p.options).toBeUndefined();
    expect(p).not.toHaveProperty("search_path");
  });

  it("qa:TC missing: only options= changes the start-up options pg sends, and that is the search_path lever", () => {
    for (const query of ["?options=-c%20search_path%3Dsho_pr1", "?schema=sho_pr1&options=-c%20search_path%3Dsho_pr1"]) {
      const { p } = params(query);
      expect(p.options, query).toBe("-c search_path=sho_pr1");
    }
    // Prisma would honour both; pg honours only the second half. The two readings differ, so leaving it to the
    // connection string is unsafe: guard() refuses options= as well as checking schema= (APL-2590 D2).
    expect(params("?schema=public").p.options).toBeUndefined();
    expect(params("?schema=public&options=-c%20search_path%3Dsho_pr1").p.options).toBe("-c search_path=sho_pr1");
  });

  it("qa:TC missing: pg keeps the host and DB name it parsed, so guard() reads the same pair pg will use", () => {
    const { p } = params("?schema=sho_pr8");
    expect(p.host).toBe("private-sho-db-do-user-45345612-0.k.db.ondigitalocean.com");
    expect(p.port).toBe(25060);
    expect(p.database).toBe("sho_staging");
    // A repeated or upper-case schema key is not rejected by pg: it ignores all of them alike, so guard() must be strict.
    for (const query of ["?schema=sho_pr8&schema=public", "?SCHEMA=sho_pr8", "?schema=", ""]) {
      expect(params(query).p, query || "(no query)").not.toHaveProperty("schema");
    }
  });
});
