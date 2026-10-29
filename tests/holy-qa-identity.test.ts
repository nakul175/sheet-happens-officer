import {it,expect,vi,afterEach} from 'vitest';
import {holyQaIdentity,centralIdentitySecret} from '../src/lib/holy-qa-identity';
const sub='12345678-1234-4234-8234-123456789abc',env={SHO_HOLY_QA:'1',APP_URL:'https://sho-qa.aplyd.org',SHO_HOLY_QA_SUBJECTS:sub,SHO_HOLY_QA_CLIENT_SECRET:'q'.repeat(48),APLYD_ACCOUNTS_CLIENT_SECRET:'p'.repeat(48)};
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('is inert by default and keeps the existing production secret selection',()=>{expect(holyQaIdentity({APP_URL:'https://sheethappensofficer.aplyd.org'})).toBeNull();expect(centralIdentitySecret({...env,SHO_HOLY_QA:'0'})).toBe('p'.repeat(48));});
it('permits only exact isolated origin, separate client and explicit subjects',()=>{expect(holyQaIdentity(env)).toEqual({origin:env.APP_URL,clientId:'sho-holy-qa',subjects:[sub]});expect(centralIdentitySecret(env)).toBe('q'.repeat(48));for(const value of ['http://staging.sheethappensofficer.com','https://sheethappensofficer.aplyd.org','https://evil.invalid','https://sho-qa.aplyd.org/'])expect(()=>holyQaIdentity({...env,APP_URL:value})).toThrow();});
it('does not fall back to the production secret or admit ambiguous identity allowlists',()=>{expect(()=>centralIdentitySecret({...env,SHO_HOLY_QA_CLIENT_SECRET:undefined})).toThrow();for(const value of ['',sub+','+sub,'not-an-id',Array(5).fill(sub).join(',')])expect(()=>holyQaIdentity({...env,SHO_HOLY_QA_SUBJECTS:value})).toThrow();});
it('checks the live QA client binding and denies identities outside its allowlist without a request',async()=>{
 for(const [k,v]of Object.entries({...env,APLYD_ACCOUNTS_ISSUER:'https://accounts.aplyd.org'}))vi.stubEnv(k,v);
 const f=vi.fn().mockResolvedValue(Response.json({active:true,sub,local_id:'native-stage'}));vi.stubGlobal('fetch',f);
 const {centralSessionActive}=await import('../src/lib/central-status');
 expect(await centralSessionActive(sub,'session','native-stage')).toBe(true);expect(JSON.parse(f.mock.calls[0][1].body).client_id).toBe('sho-holy-qa');
 expect(await centralSessionActive('22345678-1234-4234-8234-123456789abc','session','native-stage')).toBe(false);expect(f).toHaveBeenCalledTimes(1);
 f.mockResolvedValueOnce(Response.json({active:true,sub,local_id:'other-native'}));expect(await centralSessionActive(sub,'session','native-stage')).toBe(false);vi.unstubAllGlobals();
});
