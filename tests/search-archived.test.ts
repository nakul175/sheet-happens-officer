// APL-2684 / SHO-2587: the shared SQL service preserves membership and archive boundaries.
import {beforeEach,describe,expect,it,vi} from "vitest";
import type {Actor} from "@/lib/access";

const db=vi.hoisted(()=>({user:{findUniqueOrThrow:vi.fn()},$queryRaw:vi.fn()}));
vi.mock("@/lib/db",()=>({db}));
import {search} from "@/lib/search";

const admin:Actor={id:"admin-1",orgRole:"ADMIN"},member:Actor={id:"member-1",orgRole:"MEMBER"};
type Sql={strings?:readonly string[];values?:unknown[]};
const sqlText=(v:unknown):string=>{if(!v||typeof v!=="object")return String(v??"");const q=v as Sql;if(!q.strings)return "?";return q.strings.reduce((s,x,i)=>s+x+(i<(q.values?.length??0)?sqlText(q.values![i]):""),"");};

beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("CRM_VISIBLE","off");db.user.findUniqueOrThrow.mockResolvedValue({workspaceId:"ws-1"});db.$queryRaw.mockResolvedValue([]);});

describe("Include archived search (APL-2684)",()=>{
  it("keeps members inside current project membership and applies archive filtering",async()=>{
    await search(member,"vault",false);
    const closed=db.$queryRaw.mock.calls.map(c=>sqlText(c[0])).join("\n");
    expect(closed).toContain('FROM "ProjectMember"');
    expect(closed).toContain('"userId"=');
    expect(closed).toContain('"archivedAt" IS NULL');
    vi.clearAllMocks();db.user.findUniqueOrThrow.mockResolvedValue({workspaceId:"ws-1"});db.$queryRaw.mockResolvedValue([]);
    await search(member,"vault",true);
    const open=db.$queryRaw.mock.calls.map(c=>sqlText(c[0])).join("\n");
    expect(open).toContain('FROM "ProjectMember"');
    expect(open).not.toContain('"archivedAt" IS NULL');
  });

  it("lets admins search all visible projects and returns legacy grouped records",async()=>{
    db.$queryRaw
      .mockResolvedValueOnce([{id:"t1",kind:"TASK",title:"Vault task",primary_text:"Vault task",secondary_text:null,project_id:"p1",project_name:"Vault",organisation_id:null,organisation_name:null,archived_at:null,completed_at:null,is_idea:false,assignee:"Lee",rank:5}])
      .mockResolvedValueOnce([{id:"p1",kind:"PROJECT",title:"Vault",primary_text:"Vault",secondary_text:null,project_id:"p1",project_name:"Vault",organisation_id:null,organisation_name:null,archived_at:null,completed_at:null,is_idea:null,assignee:null,rank:10}]);
    const found=await search(admin,"vault",false);
    const sql=db.$queryRaw.mock.calls.map(c=>sqlText(c[0])).join("\n");
    expect(sql).not.toContain('FROM "ProjectMember"');
    expect(found.projects[0]).toMatchObject({id:"p1",type:"PROJECT",kind:"PROJECT"});
    expect(found.tasks[0]).toMatchObject({id:"t1",project:{id:"p1",name:"Vault"}});
    expect(found.results.map(x=>x.id)).toEqual(["p1","t1"]);
  });
});
