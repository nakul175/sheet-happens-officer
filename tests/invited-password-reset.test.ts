import {expect,it,vi} from 'vitest';
vi.mock('next/server',()=>({connection:async()=>{}}));
const m=vi.hoisted(()=>({consume:vi.fn(),hash:vi.fn(),update:vi.fn(),tx:vi.fn()}));
vi.mock('@/lib/auth',()=>({consumeToken:m.consume,hashPassword:m.hash,audit:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{user:{update:m.update},session:{updateMany:vi.fn()},$transaction:m.tx}}));
vi.mock('@/lib/http',async()=>{const actual=await vi.importActual<typeof import('../src/lib/http')>('../src/lib/http');return {...actual,parseBody:async()=>({token:'synthetic',password:'not-a-real-password-fixture'})}});
import {POST} from '../src/app/api/auth/reset-password/route';
it('an old native reset token cannot create a second password for an invited central identity',async()=>{m.consume.mockResolvedValue('portal_sho_12345678-1234-4234-8234-123456789abc');const response=await POST(new Request('https://app.example.invalid/api/auth/reset-password',{method:'POST'}));expect(response.status).toBe(403);expect(m.hash).not.toHaveBeenCalled();expect(m.update).not.toHaveBeenCalled();expect(m.tx).not.toHaveBeenCalled()});
