import { describe, expect, it } from "vitest";
import { account, BASE, Client, istDate, patchTask, project, task } from "./helpers";

describe("calendar subscription HTTP", () => {
  it("requires sign-in to issue and validates date ranges", async()=>{const anon=new Client(); expect((await anon.post("/api/profile/feed")).status).toBe(401); const me=await account("calendarvalidation"); expect((await me.c.get("/api/calendar?from=2026-02-31&to=2026-03-01")).status).toBe(400); });
  it("subscribes without cookies, updates dates with Undo, resets immediately and checks current membership",async()=>{
    const lead=await account("calendarlead"), me=await account("calendarreader"); const p=await project(lead,lead,[{who:me}]);
    const title="Calendar due "+Date.now(); const id=await task(lead,p.id,{title,assigneeId:me.id,dueDate:istDate(0),description:"Never expose this description"});
    const list=await me.c.get(`/api/calendar?from=${istDate(-1)}&to=${istDate(3)}`); expect(list.status).toBe(200); expect(list.json.events.some((e:{id:string})=>e.id===id)).toBe(true);
    const issued=await me.c.post("/api/profile/feed"); expect(issued.status).toBe(200); const path=issued.json.path;
    const read=async(path:string)=>{const res=await fetch(BASE+path); return {status:res.status,text:await res.text(),headers:res.headers};};
    let feed=await read(path); expect(feed.status).toBe(200); expect(feed.headers.get("cache-control")).toContain("no-store"); expect(feed.text).toContain(title); expect(feed.text).not.toContain("Never expose");
    const changed=await patchTask(me,id,{dueDate:istDate(2)}); expect(changed.status).toBe(200); const undo=changed.headers.get("x-undo-id"); expect(undo).toBeTruthy(); feed=await read(path); expect(feed.text).toContain(`DTSTART;VALUE=DATE:${istDate(2).replace(/-/g,"")}`);
    expect((await me.c.post(`/api/actions/${undo}/undo`,{})).status).toBe(200);
    const next=await me.c.post("/api/profile/feed"); expect(next.json.path).not.toBe(path); expect((await read(path)).status).toBe(404); expect((await read(next.json.path)).status).toBe(200); expect((await me.c.get("/api/profile/feed")).json).toEqual({issued:true});
    expect((await lead.c.del(`/api/projects/${p.id}/members/${me.id}?handoverTo=${lead.id}`)).status).toBeLessThan(300); expect((await read(next.json.path)).text).not.toContain(title);
  });
});
