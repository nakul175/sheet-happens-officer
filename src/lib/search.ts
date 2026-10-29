// SHO-2587 Stage A: one bounded, permission-aware keyword/stem/trigram service.
// No embeddings, external provider, chat/file contents or persisted query text.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isAdmin, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmVisible } from "@/lib/crm";

export type SearchKind = "TASK" | "PROJECT" | "DEAL" | "ORGANISATION" | "CONTACT" | "NOTE";
export type SearchHit = { id:string; kind:SearchKind; title:string; href:string; matchedField:"title"|"description"|"note"|"name"|"contact"; excerpt:string; score:number; type?:"DEAL"|"PROJECT"; archived?:boolean; done?:boolean; isIdea?:boolean; assignee?:string; project?:{id:string;name:string}; organisation?:{id:string;name:string} };
type TaskHit=SearchHit&{project:{id:string;name:string}};
type ProjectHit=SearchHit&{type:"DEAL"|"PROJECT"};
export type SearchResponse={results:SearchHit[];projects:ProjectHit[];tasks:TaskHit[];organisations:SearchHit[];contacts:SearchHit[];notes:SearchHit[]};
type Raw = { id:string; kind:SearchKind; title:string; primary_text:string; secondary_text:string|null; project_id:string|null; project_name:string|null; organisation_id:string|null; organisation_name:string|null; archived_at:Date|null; completed_at:Date|null; is_idea:boolean|null; assignee:string|null; rank:number };
export type SearchOptions = { ideasOnly?:boolean; kinds?:SearchKind[]; projectId?:string; includeDone?:boolean; limit?:number };

const clean=(s:string)=>s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g," ").replace(/\s+/g," ").trim();
const words=(s:string)=>clean(s).toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0,12)??[];
const snippet=(s:string,q:string)=>{const v=clean(s),w=words(q)[0],i=w?v.toLowerCase().indexOf(w):-1,start=Math.max(0,i<0?0:i-90),body=v.slice(start,start+220);return `${start?"…":""}${body}${start+body.length<v.length?"…":""}`;};
const wants=(k:SearchKind[]|undefined,v:SearchKind)=>!k||k.includes(v);
const empty=():SearchResponse=>({results:[],projects:[],tasks:[],organisations:[],contacts:[],notes:[]});

/** Shared by the Search screen and Concierge find_tasks. */
export async function search(user:Actor,q:string,includeArchived:boolean,ideasOnly=false,o:SearchOptions={}):Promise<SearchResponse> {
  const text=clean(q),tokens=words(text),limit=Math.min(25,Math.max(1,o.limit??25));
  if(text.length<2||!tokens.length)return empty();
  const me=await db.user.findUniqueOrThrow({where:{id:user.id},select:{workspaceId:true}}),admin=isAdmin(user),crm=crmVisible(user);
  const safeTokens=tokens.map(t=>t.replace(/[':&|!()]/g,"")).filter(Boolean),ts=safeTokens.join(" & ");
  // Multi-word searches must not leak unrelated records that merely share a
  // common word. Every term must match by stem, or (for 6+ character input)
  // by trigram typo tolerance.
  const matches=(doc:Prisma.Sql)=>Prisma.sql`(${Prisma.join(safeTokens.map(t=>Prisma.sql`(to_tsvector('english',${doc})@@plainto_tsquery('english',${t})${t.length>=6?Prisma.sql` OR ${doc} % ${t}`:Prisma.empty})`)," AND ")})`;
  const visible=(a:Prisma.Sql)=>Prisma.sql`${includeArchived?Prisma.empty:Prisma.sql`AND ${a}."archivedAt" IS NULL`} ${crm?Prisma.empty:Prisma.sql`AND ${a}."typeId" <> ${WORKSTREAM_DEAL}`} ${admin?Prisma.empty:Prisma.sql`AND EXISTS (SELECT 1 FROM "ProjectMember" pm WHERE pm."projectId"=${a}.id AND pm."userId"=${user.id})`}`;
  const rows:Raw[]=[];

  if(wants(o.kinds,"TASK"))rows.push(...await db.$queryRaw<Raw[]>(Prisma.sql`
    SELECT t.id,'TASK'::text kind,t.title,t.title primary_text,t.description secondary_text,p.id project_id,p.name project_name,NULL::text organisation_id,NULL::text organisation_name,p."archivedAt" archived_at,t."completedAt" completed_at,t."isIdea" is_idea,u.name assignee,
      (ts_rank(to_tsvector('english',coalesce(t.title,'')||' '||coalesce(t.description,'')),to_tsquery('english',${ts}))+CASE WHEN lower(t.title)=lower(${text}) THEN 10 WHEN lower(t.title) LIKE lower(${`%${text}%`}) THEN 5 ELSE 0 END)::float8 rank
    FROM "Task" t JOIN "Project" p ON p.id=t."projectId" JOIN "User" u ON u.id=t."assigneeId"
    WHERE t."deletedAt" IS NULL AND p."workspaceId"=${me.workspaceId} ${o.includeDone?Prisma.empty:Prisma.sql`AND t."completedAt" IS NULL`} ${ideasOnly||o.ideasOnly?Prisma.sql`AND t."isIdea"=true`:Prisma.empty} ${o.projectId?Prisma.sql`AND p.id=${o.projectId}`:Prisma.empty} ${visible(Prisma.sql`p`)}
      AND ${matches(Prisma.sql`lower(coalesce(t.title,'')||' '||coalesce(t.description,''))`)}
    ORDER BY rank DESC,t.id LIMIT 60`));

  if(wants(o.kinds,"PROJECT")||wants(o.kinds,"DEAL"))rows.push(...await db.$queryRaw<Raw[]>(Prisma.sql`
    SELECT p.id,CASE WHEN p."typeId"=${WORKSTREAM_DEAL} THEN 'DEAL' ELSE 'PROJECT' END::text kind,p.name title,p.name primary_text,concat_ws(' ',p.description,d."whyPursue",d.need,d."serviceLine",nm.note_text) secondary_text,p.id project_id,p.name project_name,NULL::text organisation_id,NULL::text organisation_name,p."archivedAt" archived_at,NULL::timestamp completed_at,NULL::boolean is_idea,NULL::text assignee,
      (ts_rank(to_tsvector('english',concat_ws(' ',p.name,p.description,d."whyPursue",d.need,d."serviceLine")),to_tsquery('english',${ts}))+coalesce(nm.note_rank,0)+CASE WHEN lower(p.name)=lower(${text}) THEN 10 WHEN lower(p.name) LIKE lower(${`%${text}%`}) THEN 5 WHEN p."typeId"=${WORKSTREAM_DEAL} AND nm.note_rank IS NOT NULL THEN 2 ELSE 0 END)::float8 rank
    FROM "Project" p LEFT JOIN "DealDetails" d ON d."projectId"=p.id
    LEFT JOIN LATERAL (SELECT max(ts_rank(to_tsvector('english',coalesce(n.text,'')),to_tsquery('english',${ts}))) note_rank,(array_agg(n.text ORDER BY n.id))[1] note_text FROM "Note" n WHERE n."projectId"=p.id AND n."removedAt" IS NULL AND ${matches(Prisma.sql`lower(coalesce(n.text,''))`)}) nm ON true
    WHERE p."workspaceId"=${me.workspaceId} ${visible(Prisma.sql`p`)} ${o.projectId?Prisma.sql`AND p.id=${o.projectId}`:Prisma.empty}
      AND (${matches(Prisma.sql`lower(concat_ws(' ',p.name,p.description,d."whyPursue",d.need,d."serviceLine"))`)} OR nm.note_rank IS NOT NULL)
    ORDER BY rank DESC,p.id LIMIT 60`));

  if(crm&&!ideasOnly&&!o.ideasOnly){
    if(wants(o.kinds,"ORGANISATION"))rows.push(...await db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT x.id,'ORGANISATION'::text kind,x.name title,x.name primary_text,concat_ws(' ',x.kind,x.country) secondary_text,NULL::text project_id,NULL::text project_name,x.id organisation_id,x.name organisation_name,x."archivedAt" archived_at,NULL::timestamp completed_at,NULL::boolean is_idea,NULL::text assignee,
      (ts_rank(to_tsvector('english',concat_ws(' ',x.name,x.kind,x.country)),to_tsquery('english',${ts}))+CASE WHEN lower(x.name)=lower(${text}) THEN 10 WHEN lower(x.name) LIKE lower(${`%${text}%`}) THEN 5 ELSE 0 END)::float8 rank FROM "Organisation" x
      WHERE x."workspaceId"=${me.workspaceId} ${includeArchived?Prisma.empty:Prisma.sql`AND x."archivedAt" IS NULL`} AND ${matches(Prisma.sql`lower(concat_ws(' ',x.name,x.kind,x.country))`)} ORDER BY rank DESC,x.id LIMIT 40`));
    if(wants(o.kinds,"CONTACT"))rows.push(...await db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT c.id,'CONTACT'::text kind,c.name title,c.name primary_text,concat_ws(' ',c.role,c.email,c.phone) secondary_text,NULL::text project_id,NULL::text project_name,x.id organisation_id,x.name organisation_name,NULL::timestamp archived_at,NULL::timestamp completed_at,NULL::boolean is_idea,NULL::text assignee,
      (ts_rank(to_tsvector('english',concat_ws(' ',c.name,c.role,c.email,c.phone)),to_tsquery('english',${ts}))+CASE WHEN lower(c.name)=lower(${text}) THEN 10 WHEN lower(c.name) LIKE lower(${`%${text}%`}) THEN 5 ELSE 0 END)::float8 rank FROM "Contact" c JOIN "Organisation" x ON x.id=c."organisationId"
      WHERE c."workspaceId"=${me.workspaceId} AND c."removedAt" IS NULL AND ${matches(Prisma.sql`lower(concat_ws(' ',c.name,c.role,c.email,c.phone))`)} ORDER BY rank DESC,c.id LIMIT 40`));
    if(wants(o.kinds,"NOTE"))rows.push(...await db.$queryRaw<Raw[]>(Prisma.sql`
      SELECT n.id,'NOTE'::text kind,x.name title,n.text primary_text,NULL::text secondary_text,n."projectId" project_id,p.name project_name,x.id organisation_id,x.name organisation_name,NULL::timestamp archived_at,NULL::timestamp completed_at,NULL::boolean is_idea,NULL::text assignee,
      ts_rank(to_tsvector('english',coalesce(n.text,'')),to_tsquery('english',${ts}))::float8 rank FROM "Note" n JOIN "Organisation" x ON x.id=n."organisationId" LEFT JOIN "Project" p ON p.id=n."projectId"
      WHERE n."workspaceId"=${me.workspaceId} AND n."removedAt" IS NULL AND (n."projectId" IS NULL OR (${admin} OR EXISTS(SELECT 1 FROM "ProjectMember" pm WHERE pm."projectId"=n."projectId" AND pm."userId"=${user.id}))) AND (n."projectId" IS NULL OR ${includeArchived} OR p."archivedAt" IS NULL)
      AND ${matches(Prisma.sql`lower(coalesce(n.text,''))`)} ORDER BY rank DESC,n.id LIMIT 40`));
  }
  const results=rows.filter(r=>wants(o.kinds,r.kind)).map(r=>toHit(r,text)).sort((a,b)=>b.score-a.score||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)).slice(0,limit);
  return {results,projects:results.filter(x=>x.kind==="PROJECT"||x.kind==="DEAL") as ProjectHit[],tasks:results.filter(x=>x.kind==="TASK") as TaskHit[],organisations:results.filter(x=>x.kind==="ORGANISATION"),contacts:results.filter(x=>x.kind==="CONTACT"),notes:results.filter(x=>x.kind==="NOTE")};
}

function toHit(r:Raw,q:string):SearchHit{const secondary=r.secondary_text??"",useSecondary=!!secondary&&words(q).some(w=>secondary.toLowerCase().includes(w));const matchedField:SearchHit["matchedField"]=r.kind==="NOTE"?"note":r.kind==="CONTACT"?"contact":useSecondary?"description":r.kind==="TASK"?"title":"name";return{id:r.id,kind:r.kind,title:clean(r.title),href:r.kind==="TASK"?`/projects/${r.project_id}?task=${r.id}`:r.kind==="PROJECT"||r.kind==="DEAL"?`/projects/${r.id}`:`/accounts/${r.organisation_id??r.id}`,matchedField,excerpt:snippet(useSecondary?secondary:r.primary_text,q),score:Number(r.rank),...(r.kind==="PROJECT"||r.kind==="DEAL"?{type:r.kind}:{}),...(r.archived_at?{archived:true}:{}),...(r.completed_at?{done:true}:{}),...(r.is_idea?{isIdea:true}:{}),...(r.assignee?{assignee:clean(r.assignee)}:{}),...(r.project_id&&r.project_name?{project:{id:r.project_id,name:clean(r.project_name)}}:{}),...(r.organisation_id&&r.organisation_name?{organisation:{id:r.organisation_id,name:clean(r.organisation_name)}}:{})};}
