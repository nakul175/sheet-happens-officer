// The isolated CI server starts with FF_ATTACHMENTS unset/off. No credentials or object store needed.
import { expect, it } from "vitest";
import { Client, account, project, task } from "./helpers";
it("SHO-2591 flag-off routes are 404 and task/Trash payloads expose no attachment UI",async()=>{
  const c=new Client();
  for(const [method,path] of [["GET","/api/tasks/missing/attachments"],["POST","/api/tasks/missing/attachments"],["GET","/api/tasks/missing/attachments/file"],["DELETE","/api/tasks/missing/attachments/file"],["POST","/api/tasks/missing/attachments/file/restore"],["GET","/api/projects/missing/attachments/trash"]]) expect((await c.call(method,path,method==="POST"?{}:undefined)).status).toBe(404);
  const me=await account("attachmentflagoff"),p=await project(me,me),id=await task(me,p.id);
  expect((await me.c.get(`/api/tasks/${id}`)).json.task).not.toHaveProperty("attachmentsEnabled");
  expect((await me.c.get(`/api/projects/${p.id}/trash`)).json).not.toHaveProperty("attachmentsEnabled");
});
