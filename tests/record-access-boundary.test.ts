import { expect,it,vi,beforeEach } from 'vitest';
const m=vi.hoisted(()=>({projectAccess:vi.fn()}));
vi.mock('@/lib/access',()=>({projectAccess:m.projectAccess}));
vi.mock('@/lib/db',()=>({db:{}}));
vi.mock('next/server',()=>({connection:vi.fn()}));
import { ApiError } from '@/lib/http';
import { taskAccess,recordAccess } from '@/lib/task-access';
beforeEach(()=>vi.resetAllMocks());
const actor={id:'synthetic',orgRole:'MEMBER' as const};
it('passes through successful authorization and write option without changing roles',async()=>{
 const access={role:'VIEWER'};m.projectAccess.mockResolvedValue(access);
 expect(await taskAccess(actor,'project',{write:true})).toBe(access);
 expect(m.projectAccess).toHaveBeenCalledWith(actor,'project',{write:true});
});
it('maps a hidden/missing project to the same task not-found response',async()=>{
 m.projectAccess.mockRejectedValue(new ApiError(404,'Project not found'));
 await expect(taskAccess(actor,'hidden')).rejects.toMatchObject({status:404,message:'Task not found'});
});
it('keeps action lookup non-disclosing',async()=>{
 m.projectAccess.mockRejectedValue(new ApiError(404,'Project not found'));
 await expect(recordAccess(actor,'hidden','Action')).rejects.toMatchObject({status:404,message:'Action not found'});
});
it('does not turn archived or database failures into a misleading 404',async()=>{
 for(const err of [new ApiError(409,'archived'),Error('database unavailable')]){
  m.projectAccess.mockRejectedValue(err);await expect(taskAccess(actor,'project')).rejects.toBe(err);
 }
});
