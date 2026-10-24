import { describe, expect, it } from "vitest";
import { agingDatabase } from "./e2e/helpers/owned-local-aging";
const base = "http://127.0.0.1:3469";
const raw = "postgresql://synthetic:synthetic@127.0.0.1:55432/sho_test?schema=sho_owned_aging_guard";
const env = { SHO_OWNED_LOCAL_AGING: "true", DATABASE_URL: raw };
describe("owned local aging scope", () => {
  it("accepts a disposable local schema with explicit opt-in", () => expect(agingDatabase(env,base)).toBe(raw));
  it.each([{}, {...env,SHO_OWNED_LOCAL_AGING:"false"}, {...env,DATABASE_URL:undefined}])("rejects missing local fixture prerequisites", v=>expect(()=>agingDatabase(v,base)).toThrow());
  it("rejects remote application",()=>expect(()=>agingDatabase(env,"https://app.example.com")).toThrow());
  it.each([
    raw.replace("127.0.0.1","remote.example.com"), raw.replace("/sho_test?","/production?"),
    raw.replace("sho_owned_aging_guard","public"), raw.replace("sho_owned_aging_guard","sho_staging_test"),
    raw+"&host=remote.example.com",raw+"&hostaddr=10.0.0.1",raw+"&dbname=production",raw+"&options=-csearch_path=public",
    raw+"&schema=public",
  ])("refuses remote, shared or overridden database target",u=>expect(()=>agingDatabase({...env,DATABASE_URL:u},base)).toThrow());
});
