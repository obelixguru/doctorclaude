// What every insulin actually does, in one place. Whatever a family is prescribed, the app has to
// recognise it, know how long it acts, and know whether it counts as "insulin still working".
//
// Rapid insulins carry an activity curve. A straight line over four hours (what this app used until
// v4.0) said half a dose was left at two hours; the published curves for Fiasp say about a third, and
// Ryan's own clean corrections were already 63 % done at 90 minutes. The curve below is the one Loop
// uses, with its Fiasp parameters. His logged doses were NOT enough to fit a personal curve: on the
// 8 clean corrections available every curve fits equally badly (RMSE 67 whatever the shape, peak
// anywhere from 35 to 85 minutes), so the published one stands.
//
// Basal insulins never enter "insulin still working": their job is the background, and counting them
// would block every correction. They carry what the app needs to say around them instead: how long
// they last and how many days a change takes to settle.
//
// Pure TS. Mirrored in app/.../data/Insulin.kt: change both together.

export type InsulinClass =
  | "ultra_rapid" | "rapid" | "regular" | "inhaled"
  | "nph" | "long" | "ultra_long" | "weekly" | "premix";

export interface InsulinCurve {
  /** Minutes to peak activity, after the delay. */
  peakMin: number;
  /** Minutes until the dose is entirely spent, after the delay. */
  durationMin: number;
  /** Minutes before the curve starts. */
  delayMin: number;
}

export interface InsulinInfo {
  id: string;
  /** The name to show. */
  label: string;
  inn: string;
  cls: InsulinClass;
  /** Lower-case fragments that identify it in what a parent types or dictates. */
  match: string[];
  /** Curve for mealtime insulins, null for background insulins. */
  curve: InsulinCurve | null;
  /** Background insulins: how long one dose lasts, in hours. */
  lastsHours?: [number, number];
  /** Background insulins: days before a change of dose or product has settled. */
  settlesDays?: number;
  /** Background insulins: the gap the label requires between two injections, in hours. */
  minGapHours?: number;
  /** Lower age limit of the EU label, in years; 0 means no limit stated from birth. */
  minAgeYears?: number;
}

// Curves: the presets of the Loop project. Everything else: EU labels and ISPAD 2024, checked on
// 2026-11-06 (docs/insulin-catalog.md has every figure with its source).
const FIASP: InsulinCurve = { peakMin: 55, durationMin: 360, delayMin: 10 };
const LYUMJEV: InsulinCurve = { peakMin: 55, durationMin: 360, delayMin: 10 };
/** Loop's adult preset. Its child preset peaks at 65: the slower one is kept for everybody, so that
 *  what is left of a dose is never understated. */
const ANALOG: InsulinCurve = { peakMin: 75, durationMin: 360, delayMin: 10 };
/** Human regular insulin: no published preset. Peak 1.5 to 3.5 h and 7 to 8 h of action on the labels. */
const REGULAR: InsulinCurve = { peakMin: 150, durationMin: 480, delayMin: 20 };
const INHALED: InsulinCurve = { peakMin: 29, durationMin: 300, delayMin: 10 };

export const INSULINS: InsulinInfo[] = [
  // Premixes first: "Humalog Mix25" also contains "humalog". They carry a mealtime part and a slow
  // part; only the mealtime part is modelled, so what they leave is understated after a few hours.
  { id: "premix", label: "Mélange", inn: "insuline biphasique", cls: "premix", match: ["novomix", "humalog mix", "mixtard", "actraphane", "humulin m3", "humulina 30", "umuline profil", "insuman comb", "truvelog mix", "mix 25", "mix25", "mix 30", "mix30", "mix 50", "mix50", "ryzodeg"], curve: ANALOG },

  { id: "fiasp", label: "Fiasp", inn: "insuline asparte rapide", cls: "ultra_rapid", match: ["fiasp"], curve: FIASP, minAgeYears: 1 },
  { id: "lyumjev", label: "Lyumjev", inn: "insuline lispro rapide", cls: "ultra_rapid", match: ["lyumjev", "liumjev"], curve: LYUMJEV, minAgeYears: 1 },
  { id: "novorapid", label: "NovoRapid", inn: "insuline asparte", cls: "rapid", match: ["novorapid", "novolog", "novo rapid", "trurapi", "truvelog", "kirsty", "kixelle", "dazparda", "aspart"], curve: ANALOG, minAgeYears: 1 },
  { id: "humalog", label: "Humalog", inn: "insuline lispro", cls: "rapid", match: ["humalog", "liprolog", "admelog", "bysumlog", "lispro"], curve: ANALOG },
  { id: "apidra", label: "Apidra", inn: "insuline glulisine", cls: "rapid", match: ["apidra", "glulisin"], curve: ANALOG, minAgeYears: 6 },
  { id: "actrapid", label: "Actrapid", inn: "insuline humaine", cls: "regular", match: ["actrapid", "humulin r", "humulin s", "humulina regular", "umuline rapide", "insuman rapid", "insuman infusat", "novolin r", "insulina regular", "insuline humaine", "insulina humana", "ordinaire"], curve: REGULAR },
  { id: "afrezza", label: "Afrezza", inn: "insuline inhalée", cls: "inhaled", match: ["afrezza", "inhal"], curve: INHALED },

  { id: "nph", label: "Insulatard", inn: "insuline NPH", cls: "nph", match: ["insulatard", "humulin n", "humulina nph", "insuman basal", "protaphane", "umuline nph", "nph"], curve: null, lastsHours: [12, 24] },
  // Toujeo before Lantus: "glargine 300" also contains "glargin".
  { id: "toujeo", label: "Toujeo", inn: "insuline glargine 300", cls: "ultra_long", match: ["toujeo", "optisulin", "u300", "u-300", "glargine 300"], curve: null, lastsHours: [24, 36], settlesDays: 4, minAgeYears: 6 },
  { id: "lantus", label: "Lantus", inn: "insuline glargine 100", cls: "long", match: ["lantus", "abasaglar", "abasria", "basaglar", "semglee", "ondibta", "rezvoglar", "glargin"], curve: null, lastsHours: [22, 24], settlesDays: 4, minAgeYears: 2 },
  { id: "levemir", label: "Levemir", inn: "insuline détémir", cls: "long", match: ["levemir", "detemir", "détémir"], curve: null, lastsHours: [20, 24], minAgeYears: 1 },
  // "Beyond 42 hours" on its label, yet injected once a day. 42 h is how far the effect reaches, not
  // how often it is given. The label's only requirement on timing: at least 8 h between two doses.
  { id: "tresiba", label: "Tresiba", inn: "insuline dégludec", cls: "ultra_long", match: ["tresiba", "degludec", "dégludec", "degludeg"], curve: null, lastsHours: [42, 42], settlesDays: 3, minGapHours: 8, minAgeYears: 1 },
  { id: "awiqli", label: "Awiqli", inn: "insuline icodec", cls: "weekly", match: ["awiqli", "icodec", "onswik", "efsitora"], curve: null, lastsHours: [168, 168], settlesDays: 28, minAgeYears: 18 },
];

/** The insulin behind a name as typed or dictated, or null when nothing matches. */
export function insulinByName(name?: string | null): InsulinInfo | null {
  const n = (name || "").toLowerCase().trim();
  if (!n) return null;
  for (const i of INSULINS) {
    if (i.match.some((m) => n.includes(m))) return i;
  }
  return null;
}

/** The curve for a name nothing matches: the slower analog, so what is left is never understated. */
export const DEFAULT_RAPID_CURVE: InsulinCurve = ANALOG;

/** A generic "rapide / rápida" names the class, not a product. */
const GENERIC_RAPID = ["rapid", "rápid"];

/** Is this a background insulin by name? A dose logged under one must never count as still working. */
export function isBasalInsulin(name?: string | null): boolean {
  const i = insulinByName(name);
  return !!i && i.curve === null;
}

/** The curve to apply to a dose of this insulin. */
export function curveOf(name?: string | null): InsulinCurve {
  const i = insulinByName(name);
  if (i?.curve) return i.curve;
  const n = (name || "").toLowerCase();
  if (GENERIC_RAPID.some((g) => n.includes(g))) return ANALOG;
  return DEFAULT_RAPID_CURVE;
}

/**
 * Share of a dose still to act after `minutes`, from 1 down to 0. The exponential model published by
 * the Loop project: activity rises to `peakMin` and tails off to nothing at `durationMin`.
 *
 * Fiasp, at 30 / 60 / 90 / 120 / 180 / 240 min: 94 / 75 / 54 / 36 / 14 / 4 %.
 */
export function fractionRemaining(minutes: number, c: InsulinCurve): number {
  const t = minutes - c.delayMin;
  if (!Number.isFinite(t)) return 0;
  if (t <= 0) return 1;
  const tp = c.peakMin;
  const td = c.durationMin;
  if (t >= td) return 0;
  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  const left = 1 - s * (1 - a) * ((t * t / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);
  return Math.max(0, Math.min(1, left));
}

/** Minutes after which a dose counts as finished for the words shown to a parent: under 5 % left. */
export function practicallyDoneMin(c: InsulinCurve): number {
  let m = c.delayMin;
  while (m < c.delayMin + c.durationMin && fractionRemaining(m, c) >= 0.05) m += 5;
  return m;
}

export type BasalNoticeKind = "settling" | "late" | "overlap";

export interface BasalNotice {
  kind: BasalNoticeKind;
  line: string;
}

/**
 * The one thing worth saying about the background insulin right now, or null.
 *
 * `changedAtMs` is when the profile's basal insulin last changed. A switch to a longer insulin takes
 * days to settle: for those days a fasting value judges neither the old nor the new dose, and the
 * overlap of the two can push the first nights either way.
 */
export function basalNotice(
  basalName: string | null | undefined,
  lastBasalMs: number | null | undefined,
  changedAtMs: number | null | undefined,
  nowMs: number,
  lang: string,
): BasalNotice | null {
  const info = insulinByName(basalName);
  if (!info || info.curve !== null) return null;
  const es = lang === "es";
  const days = changedAtMs ? (nowMs - changedAtMs) / 86400000 : null;
  const settles = info.settlesDays ?? 3;
  if (days != null && days >= 0 && days < settles) {
    const left = Math.max(1, Math.ceil(settles - days));
    return {
      kind: "settling",
      line: es
        ? `Insulina lenta nueva (${info.label}): tarda unos ${settles} días en estabilizarse (quedan ~${left}). Mientras tanto vigila más de cerca, sobre todo por la noche, y no cambies la dosis sin hablar con el médico.`
        : `Nouvelle insuline lente (${info.label}) : elle met environ ${settles} jours à se stabiliser (reste ~${left}). D'ici là, surveille de plus près, surtout la nuit, et ne change pas la dose sans en parler au médecin.`,
    };
  }
  if (lastBasalMs && info.lastsHours) {
    const hours = (nowMs - lastBasalMs) / 3600000;
    const due = info.cls === "weekly" ? 168 : 24;
    if (hours > due + 3 && hours < due + 36) {
      const covered = hours < info.lastsHours[1];
      const gap = info.minGapHours
        ? (es ? ` Siempre al menos ${info.minGapHours} h entre dos dosis.` : ` Toujours au moins ${info.minGapHours} h entre deux doses.`)
        : "";
      return {
        kind: "late",
        line: (es
          ? `La última dosis de ${info.label} anotada fue hace ${Math.round(hours)} h. ${covered ? "Sigue actuando, pero no la olvides." : "Puede que ya no cubra: revisa si se ha puesto."}`
          : `La dernière dose de ${info.label} notée date de ${Math.round(hours)} h. ${covered ? "Elle agit encore, mais ne l'oublie pas." : "Elle ne couvre peut-être plus : vérifie si elle a été faite."}`) + gap,
      };
    }
  }
  return null;
}
