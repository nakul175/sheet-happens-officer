import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({ task:{findUnique:vi.fn(),findUniqueOrThrow:vi.fn(),findFirst:vi.fn(),findMany:vi.fn(),deleteMany:vi.fn()}, project:{findUnique:vi.fn()}, taskAttachment:{findMany:vi.fn(),findFirst:vi.fn(),count:vi.fn(),create:vi.fn(),update:vi.fn(),delete:vi.fn()}, actionLog:{create:vi.fn(),findUnique:vi.fn(),update:vi.fn()}, auditLog:{create:vi.fn()}, comment:{deleteMany:vi.fn()}, $transaction:vi.fn(), $queryRaw:vi.fn() }));
vi.mock("@/lib/db",()=>({db:m}));
vi.mock("next/server",()=>({connection:async()=>{}}));
import { addAttachment, attachmentFilename, downloadAttachment, listAttachments, purgeExpiredAttachments, removeAttachment, removeTaskAttachmentObjects, restoreAttachment, validateAttachment, ATTACHMENT_MAX_BYTES } from "@/lib/attachments";
import { handle } from "@/lib/http";
import { undoAction } from "@/lib/undo";
import { attachmentForm } from "@/lib/attachment-upload";
import { attachmentStore } from "@/lib/attachment-store";
import { attachmentsEnabled } from "@/lib/flags";
import { purgeTrash } from "@/lib/tasks";
import { conciergeTools } from "@/lib/concierge/tools";
const user={id:"ed",orgRole:"MEMBER" as const};
const row={id:"f",taskId:"t",filename:"quote.pdf",mimeType:"application/pdf",size:8,storageKey:"object",uploadedById:"ed",removedAt:null as Date|null,createdAt:new Date()};
const task={id:"t",projectId:"p",deletedAt:null};
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("FF_ATTACHMENTS","true");vi.stubEnv("ATTACHMENT_STORE","test-stub");vi.stubEnv("NODE_ENV","test");m.$transaction.mockImplementation(fn=>fn(m));m.task.findUnique.mockResolvedValue(task);m.task.findUniqueOrThrow.mockResolvedValue(task);m.task.findFirst.mockResolvedValue(task);m.project.findUnique.mockResolvedValue({id:"p",typeId:"wst_project",archivedAt:null,members:[{userId:"ed",role:"EDITOR"}]});m.taskAttachment.count.mockResolvedValue(0);m.taskAttachment.findMany.mockResolvedValue([]);m.taskAttachment.findFirst.mockResolvedValue(row);m.taskAttachment.create.mockImplementation(({data})=>({...row,...data}));m.actionLog.create.mockResolvedValue({id:"log"});m.taskAttachment.update.mockResolvedValue(row);m.taskAttachment.delete.mockResolvedValue(row);});
describe("SHO-2591 attachment metadata security and test-only storage",()=>{
  it("defaults off and blocks production stub even with flag on",()=>{expect(attachmentsEnabled({NODE_ENV:"test"})).toBe(false);vi.stubEnv("NODE_ENV","production");expect(()=>attachmentStore()).toThrow(/not configured/);});
  it("off means no DB/storage calls and no concierge tool",async()=>{vi.stubEnv("FF_ATTACHMENTS","false");await expect(listAttachments(user,"t")).rejects.toMatchObject({status:404});expect(m.task.findUnique).not.toHaveBeenCalled();expect(conciergeTools().some(t=>t.name==="task_files")).toBe(false);});
  it("checks fresh membership and Viewer write403/read200; outsider404",async()=>{await attachmentStore().put("object",new Uint8Array([1]));m.project.findUnique.mockResolvedValue({id:"p",typeId:"wst_project",members:[{userId:"ed",role:"VIEWER"}]});expect((await downloadAttachment(user,"t","f")).bytes).toEqual(new Uint8Array([1]));await expect(removeAttachment(user,"t","f")).rejects.toMatchObject({status:403});m.project.findUnique.mockResolvedValue({id:"p",typeId:"wst_project",members:[]});await expect(downloadAttachment(user,"t","f")).rejects.toMatchObject({status:404});expect(m.project.findUnique).toHaveBeenCalledTimes(3);});
  it("rejects deal files even when visible",async()=>{m.project.findUnique.mockResolvedValue({id:"p",typeId:"wst_deal",members:[{userId:"ed",role:"EDITOR"}]});await expect(listAttachments(user,"t")).rejects.toMatchObject({status:404});});
  it("validates type, extension, provisional size and PDF signature before metadata",async()=>{for(const file of [new File(["%PDF-x"],"x.txt",{type:"application/pdf"}),new File(["bad"],"x.pdf",{type:"application/pdf"}),new File(["%PDF-x"],"x.pdf",{type:"text/plain"})])await expect(addAttachment(user,"t",file)).rejects.toMatchObject({status:400});expect(()=>validateAttachment({name:"x.pdf",type:"application/pdf",size:ATTACHMENT_MAX_BYTES+1})).toThrow(/25 MB/);expect(m.taskAttachment.create).not.toHaveBeenCalled();expect(m.actionLog.create).not.toHaveBeenCalled();});
  it("serializes required validation codes in HTTP400 JSON",async()=>{
    for (const [file,code] of [[{name:"x.exe",type:"application/pdf",size:1},"type_not_allowed"],[{name:"x.pdf",type:"application/pdf",size:ATTACHMENT_MAX_BYTES+1},"file_too_large"]] as const) {
      const response=await handle(async()=>{validateAttachment(file);return Response.json({ok:true});})();
      expect(response.status).toBe(400);expect((await response.json()).code).toBe(code);
    }
    m.taskAttachment.count.mockResolvedValue(10);
    const response=await handle(async()=>Response.json(await addAttachment(user,"t",new File(["%PDF-x"],"x.pdf",{type:"application/pdf"}))))();
    expect(response.status).toBe(400);expect((await response.json()).code).toBe("too_many_files");
  });
  it("bounds multipart uploads even with missing or dishonest content-length",async()=>{
    const req=new Request("https://local/upload",{method:"POST",headers:{"content-type":"multipart/form-data; boundary=x","content-length":"1"},body:new Uint8Array(ATTACHMENT_MAX_BYTES+65537)});
    await expect(attachmentForm(req)).rejects.toMatchObject({status:400,extra:{code:"file_too_large"}});
    await expect(attachmentForm(new Request("https://local/upload",{method:"POST",body:"bad"}))).rejects.toMatchObject({status:400});
  });
  it("rechecks membership after buffering and before storing",async()=>{
    m.project.findUnique.mockResolvedValueOnce({id:"p",typeId:"wst_project",members:[{userId:"ed",role:"EDITOR"}]}).mockResolvedValueOnce({id:"p",typeId:"wst_project",members:[]});
    await expect(addAttachment(user,"t",new File(["%PDF-x"],"x.pdf",{type:"application/pdf"}))).rejects.toMatchObject({status:404,message:"Task not found"});
    expect(m.taskAttachment.create).not.toHaveBeenCalled();
  });
  it("enforces cap under task lock and creates no rejected object/row",async()=>{m.taskAttachment.count.mockResolvedValue(10);await expect(addAttachment(user,"t",new File(["%PDF-abc"],"x.pdf",{type:"application/pdf"}))).rejects.toMatchObject({status:400,extra:{code:"too_many_files"}});expect(m.$queryRaw).toHaveBeenCalled();expect(m.taskAttachment.create).not.toHaveBeenCalled();});
  it("adds and downloads PDF, logs filename only, then soft removes without deleting object",async()=>{await addAttachment(user,"t",new File(["%PDF-abc"],"quote.pdf",{type:"application/pdf"}));const data=m.taskAttachment.create.mock.calls[0][0].data;expect(data.storageKey).not.toContain("quote");m.taskAttachment.findFirst.mockResolvedValue({...row,...data});expect(Buffer.from((await downloadAttachment(user,"t","f")).bytes).toString()).toBe("%PDF-abc");await removeAttachment(user,"t","f");expect(JSON.stringify(m.actionLog.create.mock.calls)).not.toMatch(/%PDF-|storageKey|https:|application\/pdf/);expect(m.taskAttachment.update.mock.calls[0][0].data.removedAt).toBeInstanceOf(Date);expect(await attachmentStore().get(data.storageKey)).not.toBeNull();});
  it("restores under the same cap, refuses expired removed rows",async()=>{m.taskAttachment.findFirst.mockResolvedValue({...row,removedAt:new Date()});await restoreAttachment(user,"t","f");expect(m.taskAttachment.update).toHaveBeenCalledWith({where:{id:"f"},data:{removedAt:null}});m.taskAttachment.findFirst.mockResolvedValue({...row,removedAt:new Date(Date.now()-31*86400000)});await expect(restoreAttachment(user,"t","f")).rejects.toMatchObject({status:409});});
  it("Undo restores downloadable content with current access, and flagoff blocks Undo",async()=>{
    await attachmentStore().put("object",new Uint8Array([1,2]));
    m.taskAttachment.findFirst.mockResolvedValue({...row,removedAt:new Date()});
    m.actionLog.findUnique.mockResolvedValue({id:"log",actorId:"ed",projectId:"p",targetType:"task",targetId:"t",action:"attachment.removed",beforeState:{attachmentId:"f",filename:"quote.pdf"},afterState:{attachmentId:"f",filename:"quote.pdf"},createdAt:new Date(),undoneAt:null});
    await undoAction(user,"log");expect(m.taskAttachment.update).toHaveBeenCalledWith({where:{id:"f"},data:{removedAt:null}});
    m.taskAttachment.findFirst.mockResolvedValue(row);expect((await downloadAttachment(user,"t","f")).bytes).toEqual(new Uint8Array([1,2]));
    vi.stubEnv("FF_ATTACHMENTS","false");await expect(undoAction(user,"log")).rejects.toMatchObject({status:404});
  });
  it("flattens untrusted filenames and exposes no path separators/control characters",()=>{expect(attachmentFilename("../a\nINSTRUCTION\r\n.pdf")).toBe(".. a INSTRUCTION .pdf");});
  it("deletes object before expired metadata, skips a concurrently restored file",async()=>{const store=attachmentStore();await store.put("object",new Uint8Array([1]));m.taskAttachment.findMany.mockResolvedValue([{id:"f",taskId:"t"}]);m.taskAttachment.findFirst.mockResolvedValue({...row,removedAt:new Date(0)});m.taskAttachment.delete.mockImplementation(async()=>{expect(await store.get("object")).toBeNull();return row;});expect(await purgeExpiredAttachments()).toBe(1);expect(m.taskAttachment.findMany.mock.calls[0][0].where.removedAt.lt).toBeInstanceOf(Date);m.taskAttachment.findFirst.mockResolvedValue(null);expect(await purgeExpiredAttachments()).toBe(0);});
  it("includes children when removing task objects; storage failure preserves rows",async()=>{m.taskAttachment.findMany.mockResolvedValue([{storageKey:"object"}]);vi.stubEnv("NODE_ENV","production");await expect(removeTaskAttachmentObjects(m as never,["t"])).rejects.toMatchObject({status:503});expect(m.taskAttachment.findMany.mock.calls[0][0].where.OR).toEqual([{taskId:{in:["t"]}},{task:{parentId:{in:["t"]}}}]);expect(m.taskAttachment.delete).not.toHaveBeenCalled();});
  it("task purge removes objects BEFORE deleting tasks and retains rows on storage failure",async()=>{m.task.findMany.mockResolvedValue([{id:"t"}]);m.taskAttachment.findMany.mockResolvedValue([{storageKey:"object"}]);const store=attachmentStore();await store.put("object",new Uint8Array([1]));m.task.deleteMany.mockImplementation(async()=>{expect(await store.get("object")).toBeNull();return {count:1};});expect(await purgeTrash(new Date(),{id:"t"})).toBe(1);m.task.deleteMany.mockClear();vi.stubEnv("NODE_ENV","production");await expect(purgeTrash(new Date(),{id:"t"})).rejects.toMatchObject({status:503});expect(m.task.deleteMany).not.toHaveBeenCalled();});
});
