// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartGuide, guide } from '@/components/extras/StartGuide';
import { appUrl, signInDetailsMail } from '@/lib/email';
import { INSTALL_GUIDANCE } from '@/lib/install-guidance';
const mocks=vi.hoisted(()=>({post:vi.fn()}));
vi.mock('@/components/api',()=>({api:mocks.post,useGet:()=>({data:{kind:'LEADER',people:[{id:'lead',name:'Test Leader'}]}})}));
let root:Root|undefined, phone=true, standalone=false;
beforeEach(()=>{document.body.innerHTML='<div id="root"></div>';localStorage.clear();phone=true;standalone=false;guide.gone=false;mocks.post.mockReset().mockResolvedValue({ok:true});Object.defineProperty(window,'matchMedia',{configurable:true,value:(query:string)=>({matches:query.includes('max-width')?phone:standalone,addEventListener(){},removeEventListener(){}})});Object.defineProperty(navigator,'standalone',{configurable:true,value:false});});
afterEach(()=>{act(()=>root?.unmount());root=undefined;vi.restoreAllMocks();});
async function mount(){await act(async()=>{root=createRoot(document.getElementById('root')!);root.render(<StartGuide onDismiss={()=>undefined}/>);});}
async function click(text:string){await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!.click());}
it('adds only the two install lines to the existing invitation text',()=>{
 const base=`Hi Fixture,\n\nTest Leader added you to Sheet Happens Officer. Sign in here:\n\n${appUrl()}/signin\n\nUsername: fixture@example.test\nPassword: fixture-only-password\n\nThis password is temporary. When you sign in, you will be asked to set your own password before you can do anything else. After that, this one stops working.\n\nIf you did not expect this email, ignore it and tell Test Leader. Do not forward this email, because it contains your password.`;
 const mail=signInDetailsMail('fixture@example.test','Fixture','Test Leader','fixture-only-password');
 expect(mail.text.replace(`\n\n${INSTALL_GUIDANCE}`, '')).toBe(base);
 expect(mail.text.match(/iPhone: Share, then Add to Home Screen/g)).toHaveLength(1);
 expect(mail.text).toContain('Android: menu, then Install app');
});
it('shows phone install guidance last while keeping all original help and at most three items',async()=>{await mount();const items=[...document.querySelectorAll('ol>li')];expect(items).toHaveLength(3);expect(items.at(-1)?.textContent).toContain('iPhone: Share');expect(document.body.textContent).toContain('To find a task');expect(document.body.textContent).toContain('Test Leader');expect(mocks.post).not.toHaveBeenCalled();});
it.each(['desktop','standalone','ios-standalone'])('hides install guidance on %s',async mode=>{if(mode==='desktop')phone=false;else if(mode==='standalone')standalone=true;else Object.defineProperty(navigator,'standalone',{configurable:true,value:true});await mount();expect(document.body.textContent).not.toContain('iPhone: Share');expect(document.querySelectorAll('ol>li')).toHaveLength(3);});
it('dismissal survives remount and a new signed-in guide on the same device',async()=>{await mount();await click('Dismiss install tip');expect(document.body.textContent).not.toContain('iPhone: Share');expect(mocks.post).not.toHaveBeenCalled();await act(async()=>root!.unmount());root=undefined;guide.gone=false;await mount();expect(document.body.textContent).not.toContain('iPhone: Share');});
it('whole-guide dismissal preserves its server action and remembers the device tip',async()=>{await mount();await click('Dismiss');expect(mocks.post).toHaveBeenCalledExactlyOnceWith('POST','/api/profile/start-guide',{});expect(guide.gone).toBe(true);expect(localStorage.getItem('sho.install-tip.dismissed')).toBe('1');});
