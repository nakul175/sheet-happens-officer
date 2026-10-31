"use client";
import { ATHENA_ROLES, type AthenaRole } from "@/lib/deal-classification";
import { Field } from "@/components/ui";

export type BdFormValues = { partner: string; athenaRole: string; budgetUsd: string; pwinAdjustedNfrUsd: string };
export type BdValues = { partner?: string | null; athenaRole?: AthenaRole | null; budgetUsd?: number | null; pwinAdjustedNfrUsd?: number | null };

export function DealBdFields({ values, onChange }: { values: BdFormValues; onChange: (key: keyof BdFormValues, value: string) => void }) {
  return <>
    <Field label="Partner">{(id) => <input id={id} className="in" maxLength={200} value={values.partner} onChange={(e) => onChange("partner", e.target.value)} />}</Field>
    <Field label="Athena role">{(id) => <select id={id} className="in" value={values.athenaRole} onChange={(e) => onChange("athenaRole", e.target.value)}><option value="">Not specified</option>{ATHENA_ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select>}</Field>
    <Field label="Budget (USD)">{(id) => <input id={id} className="in" type="number" min="0" max="9999999999999.99" step="0.01" value={values.budgetUsd} onChange={(e) => onChange("budgetUsd", e.target.value)} />}</Field>
    <Field label="PWin-adjusted NFR (USD)">{(id) => <input id={id} className="in" type="number" min="0" max="9999999999999.99" step="0.01" value={values.pwinAdjustedNfrUsd} onChange={(e) => onChange("pwinAdjustedNfrUsd", e.target.value)} />}</Field>
  </>;
}

export function DealBdFacts({ values, label = "BD details" }: { values: BdValues; label?: string }) {
  if (values.partner == null && values.athenaRole == null && values.budgetUsd == null && values.pwinAdjustedNfrUsd == null) return null;
  const usd = (value: number) => `USD ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <details aria-label={label}>
    <summary>BD details</summary>
    {values.partner && <div>Partner: {values.partner}</div>}
    {values.athenaRole && <div>Athena role: <span className="chip">{ATHENA_ROLES.find((role) => role.value === values.athenaRole)?.label ?? values.athenaRole}</span></div>}
    {values.budgetUsd != null && <div>Budget: {usd(values.budgetUsd)}</div>}
    {values.pwinAdjustedNfrUsd != null && <div>PWin-adjusted NFR: {usd(values.pwinAdjustedNfrUsd)}</div>}
  </details>;
}
