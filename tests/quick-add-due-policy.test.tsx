// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({api:vi.fn()}));
vi.mock("@/components/api",()=>({api:m.api}));
import { QuickAdd } from "@/components/extras/QuickAdd";
let root:Root;
beforeEach(()=>{document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById("root")!);m.api.mockReset().mockResolvedValue({ok:true});act(()=>root.render(<QuickAdd projects={[{id:"inbox",name:"Personal Inbox"}]} lastId="inbox" onClose={()=>{}}/>));});
afterEach(()=>act(()=>root.unmount()));
async function input(id:string,value:string){await act(async()=>{const el=document.getElementById(id)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});}
async function submit(){await act(async()=>{document.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});}
it("requires due for Inbox/Project capture and preserves the draft on missing date",async()=>{
 await input("qa-title","Follow up");await submit();expect(m.api).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')?.textContent).toContain("Choose a due date");expect((document.getElementById("qa-title") as HTMLInputElement).value).toBe("Follow up");expect((document.getElementById("qa-date") as HTMLInputElement).required).toBe(true);
 await input("qa-date","25/10/2026");await submit();expect(m.api).toHaveBeenCalledWith("POST","/api/projects/inbox/tasks",{title:"Follow up",isIdea:false,dueDate:"2026-10-25"});
});
it("captures an undated Idea in one request with actual isIdea state",async()=>{
 await input("qa-title","Research idea");await act(async()=>{(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();});expect((document.getElementById("qa-date") as HTMLInputElement).required).toBe(false);await submit();expect(m.api).toHaveBeenCalledTimes(1);expect(m.api).toHaveBeenCalledWith("POST","/api/projects/inbox/tasks",{title:"Research idea",isIdea:true});
});
