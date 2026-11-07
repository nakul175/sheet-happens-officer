// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useGet } from "@/components/api";
import { AUTHORITY_CHANGED } from "@/components/authority-refresh";
let root: Root | undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());document.body.innerHTML="";vi.unstubAllGlobals();});
function View() { const state=useGet<{role:string}>("/api/projects/fixture",{keepPrevious:true});return createElement("p",null,state.data?.role??"unverified"); }
const response=(role:string,status=200)=>new Response(JSON.stringify({role}),{status,headers:{"content-type":"application/json"}});
it("drops stale privileged cache and pending response, denies, then regrants in the same mounted view",async()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 const pending: Array<(r:Response)=>void>=[];vi.stubGlobal("fetch",()=>new Promise<Response>(r=>pending.push(r)));
 const host=document.createElement("div");document.body.append(host);root=createRoot(host);
 await act(async()=>root!.render(createElement(View)));
 await act(async()=>pending.shift()!(response("LEADER")));expect(host.textContent).toBe("LEADER");
 await act(async()=>window.dispatchEvent(new Event(AUTHORITY_CHANGED)));expect(host.textContent).toBe("unverified");
 const stale=pending.shift()!;
 await act(async()=>window.dispatchEvent(new Event(AUTHORITY_CHANGED)));
 await act(async()=>stale(response("LEADER")));expect(host.textContent).toBe("unverified");
 await act(async()=>pending.shift()!(response("VIEWER")));expect(host.textContent).toBe("VIEWER");
 await act(async()=>window.dispatchEvent(new Event(AUTHORITY_CHANGED)));
 await act(async()=>pending.shift()!(response("",404)));expect(host.textContent).toBe("unverified");
 await act(async()=>window.dispatchEvent(new Event(AUTHORITY_CHANGED)));
 await act(async()=>pending.shift()!(response("VIEWER")));expect(host.textContent).toBe("VIEWER");
});
