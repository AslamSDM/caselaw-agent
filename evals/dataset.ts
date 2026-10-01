/**
 * Eval set. Queries are phrased the way a user would ask, never with the case name.
 * Every target was checked to exist on TNA (2026-10-01).
 *
 * grade 3 = must find (the leading authority), 2 = relevant, should appear.
 * Negatives: no UK judgment known to address the question → pipeline should say "no strong matches".
 */
export interface EvalTarget {
  uri: string;
  ncn: string;
  grade: 2 | 3;
  /** optional paragraph ids that a good highlight should hit */
  paragraphs?: string[];
}

export interface EvalCase {
  id: string;
  query: string;
  kind: "positive" | "negative";
  targets: EvalTarget[];
  /** expected area(s) of law for the grade-3 target(s); any overlap counts */
  areas: string[];
  /** optional area filter to apply when running the search */
  filterAreas?: string[];
  /**
   * Date range the query expresses (years). Every query is checked: when omitted, the pipeline
   * must NOT infer a range. `toleranceYears` allows slack for relative phrases like "recent".
   */
  dates?: { fromYear?: number; toYear?: number; toleranceYears?: number };
  tags?: string[];
  notes?: string;
}

const t = (ncn: string, uri: string, grade: 2 | 3 = 3): EvalTarget => ({ ncn, uri, grade });

export const DATASET: EvalCase[] = [
  {
    id: "uber-worker-status",
    query: "are ride-hailing app drivers workers entitled to minimum wage and holiday pay",
    kind: "positive",
    targets: [t("[2021] UKSC 5", "uksc/2021/5"), t("[2018] UKSC 29", "uksc/2018/29", 2)],
    areas: ["employment"],
    tags: ["uksc", "employment"],
  },
  {
    id: "pimlico-worker",
    query: "plumber labelled a self-employed contractor claims worker status to bring a discrimination claim",
    kind: "positive",
    targets: [t("[2018] UKSC 29", "uksc/2018/29"), t("[2021] UKSC 5", "uksc/2021/5", 2)],
    areas: ["employment"],
    tags: ["uksc", "employment"],
  },
  {
    id: "ashers-cake",
    query: "bakery refused to make a cake iced with a slogan supporting same-sex marriage",
    kind: "positive",
    targets: [t("[2018] UKSC 49", "uksc/2018/49")],
    areas: ["human_rights"],
    tags: ["uksc", "discrimination"],
  },
  {
    id: "prorogation",
    query: "was the prime minister's advice to suspend parliament for five weeks in 2019 lawful",
    kind: "positive",
    targets: [t("[2019] UKSC 41", "uksc/2019/41")],
    areas: ["public"],
    tags: ["uksc", "constitutional"],
  },
  {
    id: "parking-penalty",
    query: "is an £85 car park overstay charge an unenforceable penalty",
    kind: "positive",
    targets: [t("[2015] UKSC 67", "uksc/2015/67")],
    areas: ["contract", "consumer"],
    tags: ["uksc", "contract"],
  },
  {
    id: "petrol-station-assault",
    query: "is an employer liable when a petrol station attendant assaulted a customer",
    kind: "positive",
    targets: [t("[2016] UKSC 11", "uksc/2016/11"), t("[2020] UKSC 12", "uksc/2020/12", 2)],
    areas: ["tort", "employment"],
    tags: ["uksc", "vicarious-liability"],
  },
  {
    id: "payroll-data-leak",
    query: "employer vicariously liable for an employee who posted staff payroll data online out of a grudge",
    kind: "positive",
    targets: [t("[2020] UKSC 12", "uksc/2020/12"), t("[2016] UKSC 11", "uksc/2016/11", 2)],
    areas: ["data_privacy", "tort"],
    tags: ["uksc", "vicarious-liability", "data"],
  },
  {
    id: "illegal-bet-restitution",
    query: "can money paid to someone to bet on shares using insider information be recovered despite the illegality",
    kind: "positive",
    targets: [t("[2016] UKSC 42", "uksc/2016/42")],
    areas: ["contract"],
    tags: ["uksc", "illegality"],
  },
  {
    id: "informed-consent",
    query: "doctor did not warn a diabetic pregnant woman about the risk of shoulder dystocia in vaginal delivery",
    kind: "positive",
    targets: [t("[2015] UKSC 11", "uksc/2015/11")],
    areas: ["clinical"],
    tags: ["uksc", "clinical"],
  },
  {
    id: "police-pedestrian",
    query: "police officers knocked over an elderly pedestrian while arresting a drug dealer: do they owe a duty of care",
    kind: "positive",
    targets: [t("[2018] UKSC 4", "uksc/2018/4")],
    areas: ["tort"],
    tags: ["uksc", "negligence"],
  },
  {
    id: "secondary-victims",
    query: "children who witnessed their father collapse and die from a heart condition the hospital failed to diagnose claim for psychiatric injury",
    kind: "positive",
    targets: [t("[2024] UKSC 1", "uksc/2024/1")],
    areas: ["clinical", "tort"],
    tags: ["uksc", "negligence"],
  },
  {
    id: "horizon-subpostmasters",
    query: "subpostmasters held liable for shortfalls shown by the Horizon computer system: relational contract and good faith",
    kind: "positive",
    targets: [t("[2019] EWHC 606 (QB)", "ewhc/qb/2019/606")],
    areas: ["contract"],
    tags: ["ewhc", "contract"],
  },
  {
    id: "black-cab-shape",
    query: "can the shape of the London black taxi be registered as a trade mark",
    kind: "positive",
    targets: [t("[2016] EWHC 52 (Ch)", "ewhc/ch/2016/52"), t("[2017] EWCA Civ 1729", "ewca/civ/2017/1729")],
    areas: ["ip"],
    tags: ["ewhc", "ewca", "ip"],
  },
  {
    id: "parent-company-pollution",
    query: "UK parent company duty of care for toxic discharges from its foreign subsidiary's copper mine",
    kind: "positive",
    targets: [t("[2019] UKSC 20", "uksc/2019/20")],
    areas: ["tort"],
    tags: ["uksc", "negligence", "jurisdiction"],
  },
  {
    id: "tribunal-fees",
    query: "employment tribunal fees unlawful because they prevent access to justice",
    kind: "positive",
    targets: [t("[2017] UKSC 51", "uksc/2017/51")],
    areas: ["public", "employment"],
    tags: ["uksc", "public"],
  },
  {
    id: "hostile-judge-libel",
    query: "trial judge's hostile interventions against a litigant in person made a libel trial unfair",
    kind: "positive",
    targets: [t("[2020] UKSC 23", "uksc/2020/23")],
    areas: ["defamation", "procedure"],
    tags: ["uksc", "procedure"],
  },
  {
    id: "auditor-swaps",
    query: "auditor's negligent advice on hedge accounting led a building society into interest rate swaps: scope of duty",
    kind: "positive",
    targets: [t("[2021] UKSC 20", "uksc/2021/20")],
    areas: ["tort", "commercial"],
    tags: ["uksc", "negligence"],
  },
  {
    id: "creditor-duty",
    query: "when must company directors consider creditors' interests if the company is at risk of insolvency",
    kind: "positive",
    targets: [t("[2022] UKSC 25", "uksc/2022/25")],
    areas: ["company"],
    tags: ["uksc", "company"],
  },
  {
    id: "black-cab-shape-ip-filter",
    query: "shape of a taxi as a trade mark",
    kind: "positive",
    targets: [t("[2016] EWHC 52 (Ch)", "ewhc/ch/2016/52"), t("[2017] EWCA Civ 1729", "ewca/civ/2017/1729")],
    areas: ["ip"],
    filterAreas: ["ip"],
    tags: ["area-filter"],
    notes: "exercises the area filter",
  },
  // ---- date ranges stated in the question ------------------------------------------------------
  {
    id: "dates-since-2020-workers",
    query: "decisions since 2020 on whether app-based drivers count as workers",
    kind: "positive",
    targets: [t("[2021] UKSC 5", "uksc/2021/5")],
    areas: ["employment"],
    dates: { fromYear: 2020 },
    tags: ["dates"],
    notes: "Pimlico [2018] UKSC 29 is relevant but must be excluded by the range",
  },
  {
    id: "dates-2019-prorogation",
    query: "2019 ruling on the lawfulness of suspending parliament",
    kind: "positive",
    targets: [t("[2019] UKSC 41", "uksc/2019/41")],
    areas: ["public"],
    dates: { fromYear: 2019, toYear: 2019 },
    tags: ["dates"],
  },
  {
    id: "dates-before-2017-vicarious",
    query: "cases decided before 2017 on an employer's liability for an employee who assaulted a customer",
    kind: "positive",
    targets: [t("[2016] UKSC 11", "uksc/2016/11")],
    areas: ["tort", "employment"],
    dates: { toYear: 2016 },
    tags: ["dates"],
    notes: "Morrison [2020] UKSC 12 must be excluded by the range",
  },
  {
    id: "dates-recent-secondary-victims",
    query: "recent cases on psychiatric injury to relatives who witness a death caused by medical negligence",
    kind: "positive",
    targets: [t("[2024] UKSC 1", "uksc/2024/1")],
    areas: ["clinical", "tort"],
    dates: { fromYear: 2021, toleranceYears: 1 },
    tags: ["dates"],
    notes: "'recent' = last 5 years per the expansion prompt",
  },
  // ---- negatives -------------------------------------------------------------------------------
  {
    id: "neg-jaguar-battery",
    query: "jaguar battery leak",
    kind: "negative",
    targets: [],
    areas: [],
    tags: ["negative"],
    notes: "plan.md research: keyword hits are incidental (London Taxi case)",
  },
  {
    id: "neg-delivery-robot",
    query: "pedestrian injured by an autonomous delivery robot on the pavement",
    kind: "negative",
    targets: [],
    areas: [],
    tags: ["negative"],
  },
  {
    id: "neg-space-tourism",
    query: "refund for a cancelled commercial space tourism flight",
    kind: "negative",
    targets: [],
    areas: [],
    tags: ["negative"],
  },
  {
    id: "neg-escaped-penguin",
    query: "zoo liable after an escaped penguin damaged a neighbour's car",
    kind: "negative",
    targets: [],
    areas: [],
    tags: ["negative"],
  },
];
