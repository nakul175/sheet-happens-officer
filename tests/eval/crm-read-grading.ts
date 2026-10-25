// A named CRM record returned to the model must link to its actual page; never infer IDs from model text.
type Named = { id: string; name: string };
function named(value: unknown): value is Named { return !!value && typeof value === "object" && typeof (value as Named).id === "string" && typeof (value as Named).name === "string"; }
export function namedCrmLinks(toolResults: { content: unknown }[], answer: string) {
 const refs = new Map<string, { label: string; href: string }>(), lower = answer.toLowerCase();
 const add = (value: unknown, prefix: string) => { if (named(value) && value.name.length >= 3 && lower.includes(value.name.toLowerCase())) { const href = `${prefix}/${value.id}`; refs.set(`${href}|${value.name}`, { label: value.name, href }); } };
 const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
 const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
 const deal = (value: unknown) => { const d = object(value); add(value, "/projects"); add(d.organisation, "/accounts"); const step = object(d.nextStep); if (typeof step.title === "string") add({ id: step.id, name: step.title }, "/tasks"); };
 const org = (value: unknown) => { const o = object(value); for (const item of [value, ...array(o.path), ...array(o.children)]) add(item, "/accounts"); for (const item of array(o.deals)) deal(item); };
 for (const result of toolResults) {
  let raw = result.content;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { continue; } }
  const data = object(object(raw).untrusted_data);
  for (const item of [...array(data.deals), ...(data.deal ? [data.deal] : [])]) deal(item);
  for (const item of [...array(data.organisations), ...(data.organisation ? [data.organisation] : [])]) org(item);
  for (const item of array(data.contacts)) { const c = object(item), scope = object(c.organisation); if (named(item) && typeof scope.id === "string" && lower.includes(item.name.toLowerCase())) refs.set(`/accounts/${scope.id}|${item.name}`, { label: item.name, href: `/accounts/${scope.id}` }); add(c.organisation, "/accounts"); }
  for (const item of array(data.notes)) add(object(item).deal, "/projects");
 }
 return [...refs.values()];
}
