// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,describe,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({push:vi.fn(),refresh:vi.fn()}));
vi.mock("next/navigation",()=>({useRouter:()=>h}));
vi.mock("@/components/client",()=>({post:vi.fn(async()=>({ok:true})),rememberEmail:vi.fn()}));
import {SignInForm} from "@/app/signin/SignInForm";
let root:ReturnType<typeof createRoot>|undefined;let host:HTMLDivElement|undefined;
afterEach(()=>{act(()=>root?.unmount());host?.remove();vi.clearAllMocks();delete (window as Window & {__SHO_RETURN_TO?:number}).__SHO_RETURN_TO;delete process.env.SIGNIN_RETURN_TO;});
async function renderAndSubmit(url:string,next?:string){window.history.replaceState(null,"",url);host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root!.render(<SignInForm justReset={false} centralEnabled next={next}/>));const link=host.querySelector('a[href^="/api/auth/aplyd/start"]');expect(link?.textContent).toBe("Continue with Aplyd");
const expected = process.env.SIGNIN_RETURN_TO === "on" && next?.startsWith("/projects") ? "/api/auth/aplyd/start?next="+encodeURIComponent(next) : "/api/auth/aplyd/start";
expect(link?.getAttribute("href")).toBe(expected);await act(async()=>host!.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));}
describe("scoped4 central sign-in preservation",()=>{
 it("preserves the suite authorization bridge even with return paths enabled",async()=>{process.env.SIGNIN_RETURN_TO="on";const target="/api/suite/authorize?client_id=fixture";await renderAndSubmit("/signin?returnTo="+encodeURIComponent(target),"/projects");expect(h.push).toHaveBeenCalledWith(target);});
 it("returns to a bounded deep link with the flag enabled",async()=>{process.env.SIGNIN_RETURN_TO="on";await renderAndSubmit("/signin","/projects?q=fixture");expect(h.push).toHaveBeenCalledWith("/projects?q=fixture");});
 it("refuses an external next path",async()=>{process.env.SIGNIN_RETURN_TO="on";await renderAndSubmit("/signin","https://example.invalid");expect(h.push).toHaveBeenCalledWith("/");});
 it("keeps flag-off legacy landing and central entry",async()=>{await renderAndSubmit("/signin","/projects");expect(h.push).toHaveBeenCalledWith("/");});
});
