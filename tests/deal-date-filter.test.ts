import { describe, expect, it } from "vitest";
import { dealDateQuery, dealDateWhere, parseDealDateFilter } from "@/lib/deal-date-filter";
const d=(value:string)=>new Date(value);
describe("SHO3043 inclusive IST date filters",()=>{
 it("no supplied filter preserves the unfiltered query",()=>{expect(parseDealDateFilter({})).toBeUndefined();expect(dealDateWhere()).toBeUndefined();expect(dealDateQuery()).toBe("");});
 it("precise submission deadlines use IST boundaries while legacy dates keep their calendar date",()=>{
  expect(dealDateWhere({basis:"submissionDeadline",from:"2026-10-25",to:"2026-10-25",includeUndated:false})).toEqual({deal:{is:{OR:[{submissionDeadlineHasTime:false,submissionDeadline:{gte:d("2026-10-25T00:00:00Z"),lt:d("2026-10-26T00:00:00Z")}},{submissionDeadlineHasTime:true,submissionDeadline:{gte:d("2026-10-24T18:30:00Z"),lt:d("2026-10-25T18:30:00Z")}}]}}});
 });
 it("created date uses exact start/end IST; expected close remains a date-only field",()=>{
  expect(dealDateWhere({basis:"createdAt",from:"2026-10-25",to:"2026-10-25",includeUndated:false})).toEqual({createdAt:{gte:d("2026-10-24T18:30:00Z"),lt:d("2026-10-25T18:30:00Z")}});
  expect(dealDateWhere({basis:"expectedClose",to:"2026-10-25",includeUndated:false})).toEqual({deal:{is:{expectedClose:{lt:d("2026-10-26T00:00:00Z")}}}});
 });
 it("open bounds and explicit undated inclusion do not silently assume missing-date behavior",()=>{
  expect(dealDateWhere({basis:"submissionDeadline",from:"2026-10-25",includeUndated:true})).toEqual({OR:[{deal:{is:{OR:[{submissionDeadlineHasTime:false,submissionDeadline:{gte:d("2026-10-25T00:00:00Z")}},{submissionDeadlineHasTime:true,submissionDeadline:{gte:d("2026-10-24T18:30:00Z")}}]}}},{deal:{is:null}},{deal:{is:{submissionDeadline:null}}}]});
  expect(dealDateWhere({basis:"createdAt",from:"2026-10-25",includeUndated:true})).toEqual({createdAt:{gte:d("2026-10-24T18:30:00Z")}});
 });
 it.each([{basis:"other",from:"2026-10-25"},{from:"2026-10-25"},{basis:"createdAt"},{basis:"createdAt",from:"2026-02-29"},{basis:"createdAt",from:"2026-10-26",to:"2026-10-25"},{basis:"expectedClose",from:"2026-10-25T00:00:00Z"},{basis:"createdAt",from:"2026-10-25",includeUndated:"yes"},{basis:"createdAt",from:"0000-01-01"}])("refuses invalid filter %j",input=>expect(()=>parseDealDateFilter(input)).toThrow());
 it("accepts leap days and serializes explicit basis/bounds/undated policy",()=>{const filter=parseDealDateFilter({basis:"expectedClose",from:"2028-02-29",includeUndated:"true"});expect(filter).toEqual({basis:"expectedClose",from:"2028-02-29",includeUndated:true});const q=new URLSearchParams(dealDateQuery(filter));expect(Object.fromEntries(q)).toEqual({dateBasis:"expectedClose",dateFrom:"2028-02-29",includeUndated:"true"});});
});
