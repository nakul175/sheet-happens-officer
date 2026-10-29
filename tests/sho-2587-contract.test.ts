import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const migration=readFileSync("prisma/migrations/20261029030000_stage_a_search/migration.sql","utf8");
const service=readFileSync("src/lib/search.ts","utf8");
const queries=JSON.parse(readFileSync("tests/fixtures/sho-2587-stage-a-queries.json","utf8")) as {query:string;expected:string}[];

describe("SHO-2587 Stage A contract",()=>{
  it("records a fixed 30-query expected-top-result set before tuning",()=>{
    expect(queries).toHaveLength(30);
    expect(new Set(queries.map(x=>x.query.toLowerCase())).size).toBe(30);
    expect(queries.every(x=>x.query&&x.expected)).toBe(true);
  });
  it("uses bounded indexed full-text/trigram search without embeddings",()=>{
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(migration.match(/USING GIN/g)?.length).toBeGreaterThanOrEqual(10);
    expect(service).toContain("Math.min(25");
    expect(service).toContain("to_tsvector('english'");
    expect(service).not.toContain("pgvector");
    expect(service).not.toContain("MODEL_API_KEY");
  });
});
