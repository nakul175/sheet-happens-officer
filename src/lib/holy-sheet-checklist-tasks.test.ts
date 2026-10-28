import {beforeEach,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({intents:new Map<string,Record<string,unknown>>(),tasks:[] as {id:string;title:string}[]}));
const tx=vi.hoisted(()=>({
 $executeRaw:vi.fn(async()=>1),
 holySheetTaskIntent:{findUnique:vi.fn(async({where}:{where:{intentId:string}})=>state.intents.get(where.intentId)??null),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{state.intents.set(data.intentId as string,data);return data;})},
 project:{findUnique:vi.fn(async()=>({id:'project-1',name:'Product',workspaceId:'workspace-1',archivedAt:null,deletedAt:null,members:[{userId:'sho-user',role:'EDITOR'}]}))},
 section:{findFirst:vi.fn(async()=>({id:'section-1'}))},
 task:{create:vi.fn(async({data}:{data:{title:string}})=>{const row={id:`task-${state.tasks.length+1}`,title:data.title};state.tasks.push(row);return row;})},
 notification:{createMany:vi.fn(async()=>({count:1}))},actionLog:{create:vi.fn(async()=>({id:'log-1'}))},auditLog:{create:vi.fn()},
}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:vi.fn(async()=>({id:'assignee-1',name:'Worker'}))},projectMember:{findMany:vi.fn(async()=>[])},holySheetTaskIntent:tx.holySheetTaskIntent,$transaction:vi.fn(async(fn:(value:typeof tx)=>unknown)=>fn(tx))}}));
vi.mock('@/lib/access',()=>({WORKERS:['LEADER','EDITOR'],projectAccess:vi.fn(async()=>({project:{id:'project-1',name:'Product'},role:'EDITOR'})),requireWrite:vi.fn(),activeMember:vi.fn(async()=>({role:'EDITOR',user:{}}))}));
vi.mock('@/lib/notify',()=>({notify:vi.fn(),logAction:vi.fn()}));
import {createChecklistTask,reviewChecklistTask} from './holy-sheet-checklist-tasks';

const actor={id:'sho-user',orgRole:'MEMBER' as const};
const input={subject:'accounts-subject',intentId:'11111111-1111-4111-8111-111111111111',sourcePageId:'page-1',sourceItemId:'22222222-2222-4222-8222-222222222222',projectId:'project-1',assigneeId:'assignee-1',dueDate:'2026-11-01',title:'Explicit task'};
beforeEach(()=>{state.intents.clear();state.tasks.length=0;vi.clearAllMocks();process.env.SUITE_HOLY_SHEET_REVIEW_KEY='review-key-that-is-at-least-32-characters-long';});
it('creates one task and replays the durable intent without duplication',async()=>{const review=await reviewChecklistTask(actor,input.subject,input);const first=await createChecklistTask(actor,input.subject,review.reviewToken),again=await createChecklistTask(actor,input.subject,review.reviewToken);expect(first).toEqual({taskId:'task-1',created:true});expect(again).toEqual({taskId:'task-1',created:false});expect(state.tasks).toHaveLength(1);});
it('binds the signed review to the central subject and rejects tampering',async()=>{const review=await reviewChecklistTask(actor,input.subject,input);await expect(createChecklistTask(actor,'different-subject',review.reviewToken)).rejects.toMatchObject({status:409});const changed=review.reviewToken.slice(0,-1)+(review.reviewToken.endsWith('a')?'b':'a');await expect(createChecklistTask(actor,input.subject,changed)).rejects.toMatchObject({status:400});expect(state.tasks).toHaveLength(0);});
