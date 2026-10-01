/**
 * Area-of-law taxonomy. Each case gets up to 3 areas: first a guess from the court (free), then
 * the relevance pass classifies properly from the judgment text (`areasClassified`).
 */
export const AREAS = [
  { id: "contract", label: "Contract" },
  { id: "tort", label: "Tort & negligence" },
  { id: "consumer", label: "Consumer & product liability" },
  { id: "clinical", label: "Clinical negligence & health" },
  { id: "employment", label: "Employment" },
  { id: "property", label: "Property & housing" },
  { id: "family", label: "Family" },
  { id: "criminal", label: "Criminal" },
  { id: "public", label: "Public & administrative" },
  { id: "human_rights", label: "Human rights" },
  { id: "immigration", label: "Immigration & asylum" },
  { id: "tax", label: "Tax" },
  { id: "ip", label: "Intellectual property" },
  { id: "company", label: "Company & insolvency" },
  { id: "commercial", label: "Commercial & financial" },
  { id: "construction", label: "Construction & engineering" },
  { id: "data_privacy", label: "Data protection & privacy" },
  { id: "defamation", label: "Defamation & media" },
  { id: "competition", label: "Competition" },
  { id: "planning_env", label: "Planning & environment" },
  { id: "trusts_probate", label: "Trusts, wills & probate" },
  { id: "procedure", label: "Civil procedure & costs" },
] as const;

export type AreaId = (typeof AREAS)[number]["id"];
export const AREA_IDS = AREAS.map((a) => a.id) as [AreaId, ...AreaId[]];
const LABELS = new Map<string, string>(AREAS.map((a) => [a.id, a.label]));

export function areaLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

export function isAreaId(id: string): id is AreaId {
  return LABELS.has(id);
}

/** TNA court codes (uk:court, e.g. "EWHC-Chancery-Patents", "UKFTT-TC") that imply an area. */
const COURT_AREAS: [RegExp, AreaId[]][] = [
  [/^UKFTT-TC|^UKUT-TCC|TAX/i, ["tax"]],
  [/^EWFC|^EWHC-Family/i, ["family"]],
  [/^EWCA-Criminal|^EWCR|CRIM/i, ["criminal"]],
  [/IAC|IMMIGRATION|^UKSIAC|^UKAIT/i, ["immigration"]],
  [/Patents|IPEC|^UKIPTrib/i, ["ip"]],
  [/^EAT|^UKEAT|EMPLOYMENT/i, ["employment"]],
  [/TCC|Technology/i, ["construction"]],
  [/Admin/i, ["public"]],
  [/^UKUT-LC|Lands|PROPERTY/i, ["property"]],
  [/SCCO|Costs/i, ["procedure"]],
  [/Commercial|Comm$|Mercantile|Admiralty/i, ["commercial"]],
  [/Insolvency|Companies|Business/i, ["company"]],
  [/^EWCOP/i, ["clinical"]],
  [/^UKFTT-GRC/i, ["data_privacy"]],
  [/CAT$|Competition/i, ["competition"]],
];

export function courtAreas(court: string | null | undefined): AreaId[] {
  if (!court) return [];
  const out = new Set<AreaId>();
  for (const [re, areas] of COURT_AREAS) if (re.test(court)) areas.forEach((a) => out.add(a));
  return [...out];
}
