import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({findMany:vi.fn(),create:vi.fn(),lock:vi.fn(),transaction:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{workspace:{findMany:m.findMany},$transaction:m.transaction}}));
vi.mock('next/server',()=>({connection:vi.fn()}));
import { assertWorkspaceUser,getOrCreateWorkspace,singleWorkspace } from '@/lib/workspace';
beforeEach(()=>vi.resetAllMocks());
it('accepts exactly one workspace and a matching user',async()=>{
 m.findMany.mockResolvedValue([{id:'one'}]);expect(await singleWorkspace()).toEqual({id:'one'});await expect(assertWorkspaceUser('one')).resolves.toBeUndefined();
});
for(const rows of [[],[{id:'one'},{id:'two'}]])it(`fails closed with ${rows.length} workspaces`,async()=>{
 m.findMany.mockResolvedValue(rows);await expect(singleWorkspace()).rejects.toMatchObject({status:503});
});
it('rejects a user outside the single configured workspace',async()=>{
 m.findMany.mockResolvedValue([{id:'one'}]);await expect(assertWorkspaceUser('foreign')).rejects.toMatchObject({status:503});
});
it('locks before inspecting/creating an empty workspace',async()=>{
 const order:string[]=[];
 m.lock.mockImplementation(async()=>{order.push('lock');});
 m.findMany.mockImplementation(async()=>{order.push('read');return [];});
 m.create.mockImplementation(async()=>{order.push('create');return{id:'one'};});
 m.transaction.mockImplementation(fn=>fn({$queryRaw:m.lock,workspace:{findMany:m.findMany,create:m.create}}));
 expect(await getOrCreateWorkspace()).toEqual({id:'one'});expect(order).toEqual(['lock','read','create']);
 expect(m.transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'ReadCommitted'});
});
it('bootstrap never selects oldest or creates a third workspace in ambiguous storage',async()=>{
 m.findMany.mockResolvedValue([{id:'one'},{id:'two'}]);m.transaction.mockImplementation(fn=>fn({$queryRaw:m.lock,workspace:{findMany:m.findMany,create:m.create}}));
 await expect(getOrCreateWorkspace()).rejects.toMatchObject({status:503});expect(m.create).not.toHaveBeenCalled();
});
