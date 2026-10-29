"use client";
import { Field } from "@/components/ui";
export type DeadlineForm = { submissionDeadline: string; submissionDeadlineTime: string; submissionDeadlineZone: string; submissionDeadlineChoice: string };
export function SubmissionDeadlineFields({ value, onChange, legacyDate }: { value: DeadlineForm; onChange: (patch: Partial<DeadlineForm>) => void; legacyDate?: string }) {
  const timed = !legacyDate || value.submissionDeadline !== legacyDate || !!value.submissionDeadlineTime;
  const change = (key: keyof DeadlineForm, text: string) => onChange({ [key]: text, submissionDeadlineChoice: "" });
  return <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <Field label="Submission deadline">{id => <input id={id} className="in" type="date" required value={value.submissionDeadline} onChange={e => change("submissionDeadline", e.target.value)} />}</Field>
    <Field label="Submission time" hint={legacyDate ? "This legacy deadline may stay date-only if its date is unchanged. Changing the deadline requires a time and timezone." : "New or changed Bid deadlines require a time and timezone."}>{id => <input id={id} className="in" type="time" required={timed} value={value.submissionDeadlineTime} onChange={e => change("submissionDeadlineTime", e.target.value)} />}</Field>
    <Field label="Submission timezone" hint="Default: Asia/Kolkata — India time (IST). Enter a valid IANA timezone to use another location.">{id => <><input id={id} className="in" required={timed} value={value.submissionDeadlineZone} onChange={e => change("submissionDeadlineZone", e.target.value)} list={`${id}-zones`} /><datalist id={`${id}-zones`}>{["Asia/Kolkata", "UTC", "Europe/London", "America/New_York", "Australia/Sydney"].map(zone => <option key={zone} value={zone} />)}</datalist></>}</Field>
    <Field label="If this time repeats" hint="During a backward clock change, choose which occurrence is intended. Nonexistent local times must be changed.">{id => <select id={id} className="in" value={value.submissionDeadlineChoice} onChange={e => onChange({ submissionDeadlineChoice: e.target.value })}><option value="">Choose occurrence if required</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select>}</Field>
  </fieldset>;
}
