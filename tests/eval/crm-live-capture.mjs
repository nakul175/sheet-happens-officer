// Preload only for the owned local CRM replay server. Never records headers, keys, environment or request prompts.
import { appendFileSync, readFileSync } from "node:fs";
const trace = process.env.CRM_EVAL_TRACE, tagFile = process.env.CRM_EVAL_TAG_FILE;
if (!trace || !tagFile || process.env.CRM_EVAL_SERVER !== "1" || process.env.MODEL_PROVIDER !== "anthropic") throw new Error("CRM eval server capture not explicitly configured");
const nativeFetch = globalThis.fetch;
let spent = 0;
const price = { input: Number(process.env.MODEL_USD_IN_PER_MTOK ?? .1), output: Number(process.env.MODEL_USD_OUT_PER_MTOK ?? .5), write: Number(process.env.MODEL_USD_CACHE_WRITE_PER_MTOK ?? .125), read: Number(process.env.MODEL_USD_CACHE_READ_PER_MTOK ?? .01) };
function save(row) { appendFileSync(trace, JSON.stringify(row) + "\n"); }
function toolResults(body) { return (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "tool_result").map(block => ({ content: block.content, isError: !!block.is_error })) : []); }
globalThis.fetch = async (input, init) => {
 const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
 const url = new URL(rawUrl);
 if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return nativeFetch(input, init);
 if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages" || init?.method !== "POST") throw new Error("CRM eval blocks unrelated external requests");
 const tag = JSON.parse(readFileSync(tagFile, "utf8"));
 const raw = typeof init?.body === "string" ? init.body : "";
 const body = JSON.parse(raw);
 const estimate = (Math.ceil(raw.length / 4) * price.input + (body.max_tokens ?? 1024) * price.output) / 1e6;
 if (spent + estimate > 1) { save({ ...tag, type: "budget_refused", spent }); throw new Error("CRM eval cost cap reached"); }
 const response = await nativeFetch(input, init);
 if (!response.ok) { save({ ...tag, type: "provider_error", status: response.status }); return response; }
 const result = await response.clone().json();
 const usage = result.usage ?? {};
 const cost = ((usage.input_tokens ?? 0) * price.input + (usage.output_tokens ?? 0) * price.output + (usage.cache_creation_input_tokens ?? 0) * price.write + (usage.cache_read_input_tokens ?? 0) * price.read) / 1e6;
 spent += cost;
 save({ ...tag, type: "model_call", provider: "anthropic", model: body.model, maxTokens: body.max_tokens, offeredTools: (body.tools ?? []).map(tool => tool.name), tools: (result.content ?? []).filter(block => block.type === "tool_use").map(block => ({ name: block.name, input: block.input })), toolResults: toolResults(body), usage, costUsd: cost, spentUsd: spent });
 return response;
};
