import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({user:{findUniqueOrThrow:vi.fn(),findUnique:vi.fn()},workspaceMembership:{findUnique:vi.fn(),count:vi.fn()},sessionWorkspace:{findUnique:vi.fn()},project:{findUnique:vi.fn()}}));
vi.mock('@/lib/db',()=>({db:mocks}));
import {scopedUser,workspaceScope,requireOriginalAccountAdministration} from '@/lib/workspace-authority';
import {selectedSessionWorkspace} from '@/lib/workspace-session';
import {projectAccess} from '@/lib/access';
const user={id:'person',workspaceId:'original',orgRole:'MEMBER',emailVerifiedAt:new Date(),deactivatedAt:null};
const actor={id:'person',workspaceId:'extra',workspaceGeneration:3,orgRole:'ADMIN' as const};
beforeEach(()=>{vi.stubEnv('SHO_MULTI_WORKSPACE_ENABLED','true');vi.clearAllMocks();mocks.user.findUniqueOrThrow.mockResolvedValue({...user});mocks.workspaceMembership.findUnique.mockResolvedValue({workspaceId:'extra',role:'MEMBER',generation:3,revokedAt:null});});
afterEach(()=>vi.unstubAllEnvs());
it('current membership downgrades a stale Admin actor, without rewriting original account',async()=>{
 expect(await scopedUser(actor)).toMatchObject({workspaceId:'extra',orgRole:'MEMBER'});
 expect(user).toMatchObject({workspaceId:'original',orgRole:'MEMBER'});
 mocks.project.findUnique.mockResolvedValue({workspaceId:'extra',members:[],actionLogs:[]});
 await expect(projectAccess(actor,'extra-project')).rejects.toMatchObject({status:404});
});
it('Admin in one workspace never bypasses a foreign project boundary',async()=>{
 mocks.workspaceMembership.findUnique.mockResolvedValue({workspaceId:'extra',role:'ADMIN',generation:3,revokedAt:null});
 mocks.project.findUnique.mockResolvedValue({workspaceId:'original',members:[],actionLogs:[]});
 await expect(projectAccess(actor,'home-project')).rejects.toMatchObject({status:404});
});
it('revoked or superseded membership denies an already-open selected session',async()=>{
 for(const m of [{role:'MEMBER',generation:3,revokedAt:new Date()},{role:'MEMBER',generation:4,revokedAt:null},{role:'SUPER_ADMIN',generation:3,revokedAt:null}]){
  mocks.workspaceMembership.findUnique.mockResolvedValue(m);await expect(scopedUser(actor)).rejects.toMatchObject({status:403});
  mocks.sessionWorkspace.findUnique.mockResolvedValue({workspaceId:'extra',generation:3,membership:m});await expect(selectedSessionWorkspace('old-session')).rejects.toMatchObject({status:403});
 }
});
it('selection is explicit, never inferred from a requested resource',()=>{
 expect(()=>workspaceScope({id:'person'})).toThrow();expect(workspaceScope(actor)).toEqual({workspaceId:'extra'});
});
it('additional Admin cannot mutate the globally shared account',async()=>{
 await expect(requireOriginalAccountAdministration(actor,'target')).rejects.toMatchObject({status:403});
});
it('original account administration is held for targets with extra memberships',async()=>{
 mocks.user.findUnique.mockResolvedValue({workspaceId:'original'});mocks.workspaceMembership.count.mockResolvedValue(1);
 await expect(requireOriginalAccountAdministration({...actor,workspaceId:'original'},'target')).rejects.toMatchObject({status:403});
});
it('original session remains original when there is no selected workspace',async()=>{
 mocks.sessionWorkspace.findUnique.mockResolvedValue(null);expect(await selectedSessionWorkspace('home')).toBeNull();
 expect(await scopedUser({...actor,workspaceId:'original'})).toEqual(user);
});

it('disabling the feature never silently changes an existing selected session to its home authority',async()=>{
 vi.stubEnv('SHO_MULTI_WORKSPACE_ENABLED','false');
 mocks.sessionWorkspace.findUnique.mockResolvedValue({workspaceId:'extra',generation:3,membership:{role:'ADMIN',generation:3,revokedAt:null}});
 await expect(selectedSessionWorkspace('selected')).rejects.toMatchObject({status:403});
 mocks.sessionWorkspace.findUnique.mockResolvedValue(null);expect(await selectedSessionWorkspace('original')).toBeNull();
});
it('only an absent selection table on a disabled installation preserves legacy behavior',async()=>{
 vi.stubEnv('SHO_MULTI_WORKSPACE_ENABLED','false');
 mocks.sessionWorkspace.findUnique.mockRejectedValue({code:'P2021',meta:{table:'public.SessionWorkspace'}});
 expect(await selectedSessionWorkspace('original')).toBeNull();
 mocks.sessionWorkspace.findUnique.mockRejectedValue({code:'P1001'});await expect(selectedSessionWorkspace('original')).rejects.toMatchObject({code:'P1001'});
});
