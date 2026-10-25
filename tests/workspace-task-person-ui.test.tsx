// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceTaskPerson } from "@/components/WorkspaceTaskPerson";
const m=vi.hoisted(()=>({people:[{id:"target",name:"Other person",isMember:false}], choose:vi.fn()}));
vi.mock("@/components/api",()=>({useGet:(url:string|null)=>({data:url?{people:m.people}:null,loading:false,error:null})}));
let root:Root;
beforeEach(()=>{document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById("root")!);m.people=[{id:"target",name:"Other person",isMember:false}];m.choose.mockReset().mockResolvedValue({ok:true});});
afterEach(()=>act(()=>root.unmount()));
async function render(purpose:"assignee"|"collaborator"="assignee"){await act(async()=>root.render(<WorkspaceTaskPerson projectId="p" purpose={purpose} onChoose={m.choose}/>));const input=document.querySelector<HTMLInputElement>('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"Other");input.dispatchEvent(new Event("input",{bubbles:true}));});}
async function click(label:string){await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent===label)!.click();});}
it("search selection does not grant membership without explicit confirmation and Cancel has no side effect",async()=>{await render();await click("Choose assignee");expect(m.choose).not.toHaveBeenCalled();expect(document.querySelector('[role="dialog"]')?.textContent).toContain("gain access to this project");expect(document.querySelector('[role="dialog"]')?.textContent).toContain("will not remove their project access");await click("Cancel");expect(m.choose).not.toHaveBeenCalled();});
it("explicit Add to project and assign sends confirmed grant once",async()=>{await render();await click("Choose assignee");await click("Add to project and assign");expect(m.choose).toHaveBeenCalledExactlyOnceWith({id:"target",name:"Other person",isMember:false},true);expect(document.querySelector('[role="dialog"]')).toBeNull();});
it("collaborator uses the same explicit grant rather than silent membership",async()=>{await render("collaborator");await click("Choose collaborator");expect(m.choose).not.toHaveBeenCalled();await click("Add to project and collaborate");expect(m.choose).toHaveBeenCalledExactlyOnceWith({id:"target",name:"Other person",isMember:false},true);});
it("existing member selection does not request new membership",async()=>{m.people=[{id:"target",name:"Other person",isMember:true}];await render();await click("Choose assignee");expect(m.choose).toHaveBeenCalledExactlyOnceWith({id:"target",name:"Other person",isMember:true},false);expect(document.querySelector('[role="dialog"]')).toBeNull();});
it("failed atomic operation retains confirmation with actionable error and no success reset",async()=>{m.choose.mockResolvedValue({ok:false,error:"This task changed. Refresh it."});await render();await click("Choose assignee");await click("Add to project and assign");expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This task changed. Refresh it.");expect(document.querySelector('input')?.value).toBe("Other");});
