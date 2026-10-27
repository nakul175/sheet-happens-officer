import { z } from "zod";

export const OPPORTUNITY_TYPE_CODES = ["RFP_RFA", "EOI", "OTC", "CV_LTA"] as const;
export type OpportunityType = typeof OPPORTUNITY_TYPE_CODES[number];
export const OPPORTUNITY_TYPES: readonly { value: OpportunityType; label: string }[] = [
  { value: "RFP_RFA", label: "RFP/RFA" }, { value: "EOI", label: "EOI" },
  { value: "OTC", label: "OTC" }, { value: "CV_LTA", label: "CV/LTA" },
];
export const ATHENA_ENTITY_CODES = ["ATHENA_INDIA", "APLYD_INDIA", "ATHENA_USA", "ATHENA_KENYA", "ATHENA_UK", "ATHENA_BANGLADESH", "TOLADATA"] as const;
export type AthenaEntity = typeof ATHENA_ENTITY_CODES[number];
export const ATHENA_ENTITIES: readonly { value: AthenaEntity; label: string }[] = [
  { value: "ATHENA_INDIA", label: "Athena India" }, { value: "APLYD_INDIA", label: "Aplyd India" },
  { value: "ATHENA_USA", label: "Athena USA" }, { value: "ATHENA_KENYA", label: "Athena Kenya" },
  { value: "ATHENA_UK", label: "Athena UK" }, { value: "ATHENA_BANGLADESH", label: "Athena Bangladesh" },
  { value: "TOLADATA", label: "Toladata" },
];
export const opportunityTypeField = z.enum(OPPORTUNITY_TYPE_CODES);
export const athenaEntityField = z.enum(ATHENA_ENTITY_CODES);
// Match Decimal(15,2), without rounding an entered amount or conflating unknown with zero.
export const netFeeRevenueUsdField = z.number().min(0).max(9999999999999.99).multipleOf(0.01);
export const dealClassificationFields = z.object({
  opportunityType: opportunityTypeField.nullish(),
  athenaEntity: athenaEntityField.nullish(),
  netFeeRevenueUsd: netFeeRevenueUsdField.nullish(),
});
export type DealClassificationInput = z.infer<typeof dealClassificationFields>;
