// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ path: '/', loaded: false, hidden: false, density: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => state.path, useRouter: () => ({}) }));
vi.mock('next/link', () => ({ default: ({children,...props}: React.AnchorHTMLAttributes<HTMLAnchorElement>) => h('a', props, children) }));
vi.mock('@/components/api', () => ({ initials: () => 'NJ', ago: () => '', useGet: () => ({}), api: (...a: unknown[]) => { state.density(...a); return Promise.resolve({ok:true}); } }));
vi.mock('@/components/concierge/ConciergeProvider', () => ({ ConciergeProvider: ({children}: {children: React.ReactNode}) => children, useConcierge: () => state }));
vi.mock('@/components/concierge/Concierge', () => ({ ConciergeDock: () => h('aside', {'data-dock':true}), ConciergeBar: () => null, ConciergeFab: () => null }));
vi.mock('@/components/concierge/Launcher', () => ({ ConciergeHost: () => null, ConciergeNavItem: () => h('button', null, 'Show Concierge'), openConcierge: vi.fn() }));
vi.mock('@/components/extras/Extras', () => ({ Extras: ({children}: {children: React.ReactNode}) => children, NewTaskButton: () => h('button', null, 'New task'), SearchButton: () => h('button', null, 'Search') }));
vi.mock('@/app/(app)/Bell', () => ({ Bell: () => h('button', {'aria-label':'Notifications'}) }));
import { Shell, Page } from '../src/app/(app)/Shell';
let root: Root;
const user = {id:'me',name:'Nakul Jain',email:'fixture@example.test',orgRole:'SUPER_ADMIN' as const,crm:true,review:true};
async function mount(role: 'SUPER_ADMIN'|'MEMBER'='SUPER_ADMIN') { document.body.innerHTML='<div id="root"></div>'; await act(async()=>{root=createRoot(document.getElementById('root')!);root.render(h(Shell,{user:{...user,orgRole:role},children:h(Page,{dock:true,title:'Example',children:'Content'})}));}); }
afterEach(()=>{act(()=>root?.unmount());state.loaded=false;state.hidden=false;state.density.mockReset();});
it('keeps admin utilities out of primary navigation and preserves account keyboard dismissal and density',async()=>{
 await mount();const primary=document.querySelector('.primary-nav')!;
 expect(primary.textContent).toContain('HomeMy tasksProjects');expect(primary.textContent).not.toMatch(/Usage|Audit|Search|Concierge/);
 const trigger=document.querySelector<HTMLButtonElement>('.account-trigger')!;
 await act(async()=>trigger.click());expect(document.querySelector('.account-options')!.textContent).toContain('Audit log');
 await act(async()=>document.querySelector<HTMLButtonElement>('.account-options .density')!.click());expect(state.density).toHaveBeenCalledWith('PUT','/api/profile/density',{compact:true});
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.account-options')).toBeNull();expect(document.activeElement).toBe(trigger);});
});
it('does not expose admin links to members and retains distinct Home and My tasks destinations',async()=>{
 await mount('MEMBER');await act(async()=>document.querySelector<HTMLButtonElement>('.account-trigger')!.click());
 expect(document.querySelector('a[href="/audit"]')).toBeNull();expect(document.querySelector('a[href="/usage"]')).toBeNull();
 expect(document.querySelector('.primary-nav a[href="/my-tasks"]')!.textContent).toBe('My tasks');
});
it('reserves no Concierge column before preferences load or when hidden',async()=>{
 await mount();expect(document.querySelector('.with-dock')).toBeNull();expect(document.querySelector('[data-dock]')).toBeNull();
 state.loaded=true;state.hidden=true;await act(async()=>root.render(h(Shell,{user,children:h(Page,{dock:true,children:'Content'})})));expect(document.querySelector('.with-dock')).toBeNull();
 state.hidden=false;await act(async()=>root.render(h(Shell,{user,children:h(Page,{dock:true,children:'Content'})})));expect(document.querySelector('.with-dock')).not.toBeNull();
});
it('transfers focus to the incoming phone menu after the outgoing history entry is consumed',async()=>{
 await mount();
 const more=[...document.querySelectorAll<HTMLButtonElement>('.tabbar button')].find(b=>b.textContent?.includes('More'))!;
 const account=document.querySelector<HTMLButtonElement>('.account-trigger')!;
 await act(async()=>more.click());
 await act(async()=>{account.dispatchEvent(new Event('pointerdown',{bubbles:true}));account.click();});
 await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.tabmore')).toBeNull();expect(document.querySelector('.account-options')).not.toBeNull();expect(document.activeElement).toBe(account);});
 await act(async()=>{more.dispatchEvent(new Event('pointerdown',{bubbles:true}));more.click();});
 await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.account-options')).toBeNull();expect(document.querySelector('.tabmore')).not.toBeNull();expect(document.activeElement).toBe(more);});
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await vi.waitFor(async()=>{await act(async()=>{});expect(document.querySelector('.tabmore')).toBeNull();});
});
