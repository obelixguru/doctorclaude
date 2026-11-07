# Insulin catalogue: Spain, France, EU

Snapshot date: 2026-11-06. This is reference data for a dose engine, not a prescription. Any change of insulin or dose belongs to the child's diabetes team.

## 1. The "42 h" insulin: it is Tresiba

**Confirmed: insulin degludec (Tresiba).**

- The figure is in its label: "The duration of action of Tresiba is beyond 42 hours within the therapeutic dose range" [label]. The Spanish sheet says "superior a 42 horas" [label]. ISPAD 2024 Table 1 also lists 42 h [guideline].
- All 31 EU product-information files collected here were searched for "42 hours". Only Tresiba's contains it [label].
- 42 h is a lower bound, not an end point. It does not mean one injection every 42 h: Tresiba is injected once a day [label].
- Toujeo is ruled out: "beyond 24 hours (up to 36 hours)" [label].
- Awiqli is ruled out: once weekly, adults only, and not marketed in Spain [label].
- Onswik (efsitora) is ruled out: once-weekly class [guideline], type 2 only [label].
- Ryzodeg contains degludec, but its label says "beyond 24 hours" and it is not marketed in Spain [label].
- Tresiba fits this child: authorised from 1 year, and U100 FlexTouch, U100 Penfill and U200 FlexTouch are marketed in Spain [label].

The identification rests on one number, so the family should still read the exact name and strength on the prescription.

## 2. Tables by class

**Tags.** [label] = regulator text: EMA product information and dataset, CIMA sheets and register, AEMPS notices, BDPM. "US" marks an FDA label. [guideline] = ISPAD, 2024 unless another year is given. [study] = published trial or cohort. [secondary] = reviews, news, and open-source code constants (exact for what the software does, but not clinical evidence).

**Status.** EU = EMA medicines dataset. Spain = CIMA `comerc` flag, which means declared as marketed, not funded or in stock. "No CIMA record" means the product is absent from the register. France = BDPM files. All read on 2026-11-06.

### ultra_rapid

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) | Model values [secondary] |
|---|---|---|---|---|---|---|---|---|---|---|
| **Fiasp** / insulin aspart with nicotinamide | 100 U/mL | Authorised (2017) | Yes: FlexTouch, Penfill, vial. PumpCart: active supply problem, stop announced for 2026 | Yes: FlexTouch, Penfill, vial, PumpCart | 1 y; no experience under 2 y [label] | No absolute EU value: "5 minutes earlier" than NovoRapid, in blood after ~4 min [label]. 5–20 min [guideline]. ~16–20 min [label, US] | 1–3 h [label]. ~1.5–2.2 h [guideline]. ~91–133 min, dose-dependent [label, US] | 3–5 h [label]. ~5–7 h [guideline]. ~5–7 h, dose-dependent [label, US] | 57 min [label]. ~1.1 h [label, US] | Loop `fiasp`: td 360, tp 55, delay 10. oref0 `ultra-rapid`: peak 55, custom 35–100, no delay term, DIA set by user, minimum 5 h |
| **Lyumjev** / insulin lispro with citrate and treprostinil | 100, 200 U/mL | Authorised (2020) | No: all 4 CIMA entries not marketed | Yes: Junior KwikPen, vial, 200 KwikPen. Cartridge stopped 30/04/2026 | 1 y. U200 not established under 18 y [label] | 20 min [label]. ~15–17 min [guideline]. ~15–17 min [label, US] | 1–3 h [label]. ~2–3 h [guideline]. ~120–174 min, dose-dependent [label, US] | 5 h [label]. ~5–7 h [guideline]. ~4.6–7.3 h, dose-dependent [label, US] | SC not published. IV 44 min [label] | Loop `lyumjev`: td 360, tp 55, delay 10. oref0: no Lyumjev curve, its code names only Fiasp for `ultra-rapid`. AAPS `OREF_LYUMJEV`: peak 45 |

### rapid

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) | Model values [secondary] |
|---|---|---|---|---|---|---|---|---|---|---|
| **NovoRapid** (US: NovoLog) / insulin aspart | 100 U/mL | Authorised (1999) | Yes: vial, FlexPen, Penfill, PumpCart | Yes: vial, FlexPen, Penfill, PumpCart | 1 y [label] | 10–20 min [label]. 15 min [guideline] | 1–3 h [label], [guideline]. PK 40 min [label] | 3–5 h [label], [guideline] | Not in EU label. 81 min [label, US] | Loop `rapidActingAdult`: td 360, tp 75, delay 10. `rapidActingChild`: td 360, tp 65, delay 10. oref0 `rapid-acting`: peak 75, custom 50–120, no delay term, DIA minimum 5 h |
| **Humalog** (also Liprolog) / insulin lispro | 100, 200 U/mL | Authorised (1996) | Yes: KwikPen 100, Junior KwikPen, KwikPen 200 | Yes: vial, cartridge, KwikPen, Junior KwikPen, KwikPen 200 | No limit stated, "adults and children" [label] | ~15 min [label]. 15–30 min [guideline] | No PD peak in EU label. 1–2 h [guideline]. PK 30–70 min [label] | 2–5 h [label]. ≤5 h [guideline] | Not in EU label. 1 h [label, US] | Same as NovoRapid |
| **Apidra** / insulin glulisine | 100 U/mL | Authorised (2004) | Yes: SoloStar, cartridge | Yes: cartridge, vial, SoloStar | 6 y [label] | 10–20 min [label]. 12–30 min [guideline] | 1.5 h [guideline]. PK 55 min [label] | ~4 h (leaflet) [label]. ~5.3 h [guideline] | 42 min, IQR 37–75 min [label] | Same as NovoRapid |
| **Insulin lispro Sanofi** (US: Admelog) / insulin lispro, biosimilar | 100 U/mL | Authorised (2017) | No CIMA record | No BDPM record | No limit stated [label] | ~15 min [label] | PK 30–70 min [label] | 2–5 h [label] | Not published | None: Loop has no preset |
| **Bysumlog** / insulin lispro, biosimilar (Sandoz) | 100 U/mL | Authorised (2026) | No: registered 2026, not marketed | No BDPM record | No limit stated [label] | ~15 min [label] | PK 30–70 min [label] | 2–5 h [label] | Not published | None |
| **Insulin aspart Sanofi** (Canada: Trurapi) / insulin aspart, biosimilar | 100 U/mL | Authorised (2020) | No CIMA record | Yes: as Insuline asparte Sanofi | 1 y [label] | 10–20 min [label] | 1–3 h [label] | 3–5 h [label] | Not published | None |
| **Kirsty** (ex Kixelle) / insulin aspart, biosimilar | 100 U/mL | Authorised (2021) | No CIMA record | No BDPM record | 1 y [label] | 10–20 min [label] | 1–3 h [label] | 3–5 h [label] | Not published | None |
| **Dazparda** / insulin aspart, biosimilar (Sandoz) | 100 U/mL | Authorised (2026) | No: registered 2026, not marketed | No BDPM record | 1 y [label] | 10–20 min [label] | 1–3 h [label] | 3–5 h [label] | Not published | None |

Loop picks `fiasp`, `lyumjev` or `afrezza` by insulin type. Every other type falls back to the user's default rapid model, or `rapidActingAdult` when none is set [secondary]. Afrezza has a Loop preset (td 300, tp 29, delay 10) but no record in the EMA dataset, so it is left out here [label].

Loop and oref0 share one curve [secondary]. With td the action duration and tp the peak:

```
tau = tp * (1 - tp/td) / (1 - 2*tp/td)
a   = 2*tau / td
S   = 1 / (1 - a + (1 + a) * exp(-td/tau))
IOB(t) = 1 - S*(1 - a) * ((t^2 / (tau*td*(1 - a)) - t/tau - 1) * exp(-t/tau) + 1)
```

In Loop, t is counted after the delay, so effect duration is td + delay, which is 370 min for these presets. In oref0, td is `dia * 60` and there is no delay. Both `tp` and `peak` are curve parameters, not clinical peaks.

### regular

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) |
|---|---|---|---|---|---|---|---|---|---|
| **Actrapid** / human insulin | 40, 100 IU/mL | Authorised (2002) | Yes: vial only. InnoLet stopped | Yes: vial. Penfill stopped 19/09/2025 | No limit stated, "can be used in children and adolescents" [label] | Within 30 min [label]. 30–60 min [guideline] | 1.5–3.5 h [label]. 2–4 h [guideline] | ~7–8 h [label]. 5–8 h [guideline] | ~2–5 h [label] |
| **Humulina Regular** (Humulin R; France: Umuline Rapide) / human insulin | 100 IU/mL | National, not EMA | Yes: vial | No: Umuline Rapide stopped 30/04/2026 | "No se dispone de datos" [label] | Graph only in label. 30–60 min [guideline] | 2–4 h [guideline] | 5–8 h [guideline] | Not published |
| **Insuman Rapid** / human insulin | 40, 100 IU/mL | Authorised (1997) | No: every entry not marketed | No BDPM record | No limit stated [label] | Within 30 min [label] | 1–4 h [label] | 7–9 h [label] | Not published |

Related products: Insuman Infusat is not marketed in Spain, and its French authorisation is archived. Insuman Implantable (400 IU/mL, implanted pump) is marketed in France [label].

### nph

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) | Steady state | Late or missed dose |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Insulatard** (also Protaphane) / isophane human insulin | 40, 100 IU/mL | Authorised (2002) | Yes: vial, FlexPen. FlexPen stop announced for 2026 | Yes: vial only. FlexPen, Penfill, InnoLet stopped | No limit stated [label] | Within 1.5 h [label]. 2–4 h [guideline] | 4–12 h [label], [guideline] | ~24 h [label]. 12–24 h [guideline] | ~5–10 h [label] | Not stated | No timing rule. Leaflet: glucose may get too high [label] |
| **Humulina NPH** (Humulin N; France: Umuline NPH) / isophane human insulin | 100 IU/mL | National, not EMA | Yes: vial, KwikPen | Yes: KwikPen only. Vial and cartridge stopped 30/04/2026 | "No se dispone de datos" [label] | Graph only in label. 2–4 h [guideline] | 4–12 h [guideline] | 12–24 h [guideline] | Not published | Not stated | Not in the sheet [label] |
| **Insuman Basal** / isophane human insulin | 40, 100 IU/mL | Authorised (1997) | No: every entry not marketed | No BDPM record | No limit stated [label] | Within 60 min [label] | 3–4 h [label] | 11–20 h [label] | Not published | Not stated | No timing rule. Leaflet wording as for Insuman Rapid: check glucose often [label] |

### long

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) | Steady state | Late or missed dose |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Lantus** / insulin glargine U100 | 100 U/mL | Authorised (2000) | Yes: SoloStar, cartridge, vial | Yes: SoloStar, cartridge, vial | 2 y [label] | "Slower" than NPH, no figure [label]. 2–4 h [guideline] | Peakless [label]. "8–12 h, no pronounced peak" [guideline] | "Prolonged", no figure [label]. ~22–24 h [guideline]. Median 24 h, range 10.8 to >24 [label, US] | Not published. 12–14 h [secondary] | 2–4 days [label] | "Same time each day", no window. Leaflet: check glucose often, no double dose [label] |
| **Abasaglar** (US: Basaglar; ex Abasria) / glargine U100, biosimilar | 100 U/mL | Authorised (2014) | Yes: KwikPen | Yes: KwikPen. Cartridge stopped 30/04/2026 | 2 y [label] | As Lantus | As Lantus | As Lantus | Not published | 2–4 days [label] | As Lantus [label] |
| **Semglee** / glargine U100, biosimilar | 100 U/mL | Authorised (2018) | Yes: pre-filled pen | Yes: declared 23/02/2026 | 2 y [label] | As Lantus | As Lantus | As Lantus | Not published | 2–4 days [label] | As Lantus [label] |
| **Ondibta** / glargine U100, biosimilar (Sandoz) | 100 U/mL | Authorised (2026) | No: registered 2026, not marketed | No BDPM record | 2 y [label] | As Lantus | As Lantus | As Lantus | Not published | 2–4 days [label] | As Lantus [label] |
| **Levemir** / insulin detemir | 100 U/mL | Authorised (2004) | No: FlexPen and InnoLet not marketed | FlexPen, Penfill still shown as marketed; stop by 31/12/2026 [secondary] | 1 y [label] | 1–2 h [guideline] | Over 50% of maximum from 3–4 h to ~14 h; PK 6–8 h [label]. "4–7 h, no pronounced peak" [guideline] | Up to 24 h, dose-dependent [label]. 20–24 h [guideline] | 5–7 h [label] | 2–3 doses if given twice daily [label] | No timing rule. Leaflet: glucose may get too high [label] |

### ultra_long

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) | Steady state | Late or missed dose |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Toujeo** / insulin glargine U300 | 300 U/mL | Authorised (2000, shared history with Optisulin) | Yes: SoloStar, DoubleStar | Yes: SoloStar, DoubleStar | 6 y [label] | 2–6 h [guideline]. Develops over 6 h [label, US] | No pronounced peak [guideline] | Beyond 24 h, up to 36 h [label]. 30–36 h [guideline] | 18–19 h [label] | 3–4 days [label]. At least 5 days [label, US] | Up to 3 h before or after usual time. Forgotten: check glucose, resume usual schedule, no double dose. Leaflet: inject if within 3 h; past 3 h, skip and take the next dose next day [label] |
| **Tresiba** / insulin degludec | 100, 200 U/mL | Authorised (2013) | Yes: FlexTouch U100, Penfill U100, FlexTouch U200 | Yes: FlexTouch U200, Penfill U100. No BDPM record for FlexTouch U100 | 1 y [label] | 30–90 min [guideline]. PK onset ~1 h [label, US] | Flat [label]. No pronounced peak [guideline] | Beyond 42 h [label]. 42 h [guideline] | ~25 h [label] | 2–3 days [label]. 3–4 days [label, US] | At least 8 h between injections. Forgotten: take on discovery, then resume usual schedule. No clinical experience with flexible timing in children [label]. US, children: call the team, monitor more until the next scheduled dose [label, US] |

Tresiba steps: U100 FlexTouch 1–80 units in steps of 1. U200 FlexTouch 2–160 units in steps of 2. No dose conversion between strengths. Not for insulin pumps [label].

### weekly

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) | Steady state | Late or missed dose |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Awiqli** / insulin icodec | 700 U/mL | Authorised (2024) | No: registered 2026, not marketed | No BDPM record | 18 y; none below 18 [label] | Not published | Not published | Covers a full week, modelled [label] | ~1 week [label]. ~8 days [guideline] | 2–4 weeks; 2–3 with loading dose [label] | As soon as possible. Type 1: keep weekly dosing from the new day, monitor fasting glucose [label] |
| **Onswik** / insulin efsitora alfa | 500, 1000 U/mL [label] | CHMP positive 25/06/2026. EMA dataset not yet "Authorised" | No: registered 01/09/2026, not marketed | No BDPM record | Not verified. Indication: type 2 [label] | Not verified | Not verified | Not verified | Not verified | Not verified | Not verified |

For type 1, the Awiqli label warns of higher hypoglycaemia risk than degludec: 19.93 vs 10.37 severe or clinically significant episodes per patient-year. It says to use it "only" if a clear benefit is expected [label].

### premix

| Brand / INN | Conc. | EU | Spain today | France today | Min age (EU) | Onset | Peak | Duration | Half-life (SC) |
|---|---|---|---|---|---|---|---|---|---|
| **NovoMix 30, 50** / aspart + protamine-aspart | 100 U/mL | Authorised (2000) | Yes: 30 FlexPen. 50 and 70 not marketed | Yes: 30 FlexPen, 30 Penfill, 50 FlexPen (stop by 31/12/2026 [secondary]). 70 archived | 30: 10 y. 50: adults only [label] | 10–20 min [label] | 1–4 h [label] | Up to 24 h [label] | 8–9 h (NovoMix 30) [label] |
| **Humalog Mix25, Mix50** / lispro + protamine-lispro | 100 U/mL | Authorised (1996) | Yes: Mix25 and Mix50 KwikPen | Yes: KwikPens. Cartridges stopped 30/04/2026 | Under 12 y only if expected benefit [label] | ~15 min, lispro part [label] | Not published | Protamine part "similar to" NPH, ~15 h profile [label] | Not published |
| **Mixtard 30** (also Actraphane) / soluble + isophane human | 40, 100 IU/mL | Authorised (2002) | Yes: vial only. InnoLet stopped | Yes: vial | No limit stated [label] | Within 30 min [label] | 2–8 h [label] | Up to 24 h [label] | ~5–10 h [label] |
| **Humulina 30:70** (France: Umuline Profil 30) / soluble + isophane human | 100 IU/mL | National, not EMA | Yes: vial, KwikPen | Yes: KwikPen only. Vial, cartridge stopped 30/04/2026 | "No se dispone de datos" [label] | Graph only | Graph only | Graph only | Not published |
| **Insuman Comb 15, 25, 30, 50** / soluble + isophane human | 40, 100 IU/mL | Authorised (1997) | No: every entry not marketed | No BDPM record | No limit stated [label] | 15–30: within 30–60 min. 50: within 30 min [label] | 15–30: 2–4 h. 50: 1.5–4 h [label] | 15: 11–20 h. 25, 30: 12–19 h. 50: 12–16 h [label] | Not published |
| **Ryzodeg** / degludec 70% + aspart 30% | 100 U/mL | Authorised (2013) | No: not marketed | No BDPM record | 2 y [label] | "Soon after injection" [label] | Not published | Beyond 24 h [label] | 25 h, degludec part. Steady state 2–3 days [label] |
| **Truvelog Mix 30** / aspart premix, biosimilar | 100 U/mL | Withdrawn 25/01/2024 | No CIMA record | No BDPM record | 10 y [label] | 10–20 min [label] | 1–4 h [label] | Up to 24 h [label] | Not published |

Left out because they are not indicated in type 1: Xultophy, Suliqua and Kyinsu (type 2 only) [label].

## 3. JSON

Rules for the numbers:

- Source order: EU label, then ISPAD 2024, then US label, else `null`. Notes say where each value comes from.
- `onsetMin` uses the earliest published value. "Within X" is stored as X.
- `halfLifeH` and `steadyStateDays` use the upper end of a published range, the cautious side. The full range is in the notes.
- `durationHHigh` is `null` when the label gives only a floor, such as "beyond 42 hours".
- `peakMinLow` and `peakMinHigh` are `null` for peakless basal insulins, even where ISPAD prints a window with "no pronounced peak".
- `minAgeYears` is `null` when the label states no numeric lower limit.
- `model*` fields are filled only where Loop has a preset for that brand. `modelPeakMin` holds the adult preset; the child value is in the notes. Biosimilars stay `null` because no source maps them. Mapping them by INN would be your decision.
- `marketedSpain`: `true` if at least one presentation is marketed, `false` otherwise, including no CIMA record.

The aliases are spelling and dictation variants I generated. They are not sourced. They never contain an INN shared by several products, so "glargina" or "aspart" must resolve through `inn` and then ask which product. "Humulina", "Insuman", "Umuline", "Novo" and "Mix" alone are ambiguous and should also trigger a question.

```json
[
  {
    "id": "fiasp",
    "inn": "insulin aspart",
    "class": "ultra_rapid",
    "brands": ["Fiasp", "Fiasp FlexTouch", "Fiasp Penfill", "Fiasp PumpCart"],
    "aliases": ["fias", "fiasb", "fiaspe", "fiaspa", "fia sp", "faster aspart", "fast aspart", "aspart ultra rapide", "asparta ultrarrapida"],
    "onsetMin": 5,
    "peakMinLow": 60,
    "peakMinHigh": 180,
    "durationHLow": 3,
    "durationHHigh": 5,
    "halfLifeH": 0.95,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": 55,
    "modelDurationMin": 360,
    "modelDelayMin": 10,
    "marketedSpain": true,
    "notes": "Onset 5-20 min [guideline]; EU label only says 5 min earlier than NovoRapid. Peak 1-3 h, duration 3-5 h, half-life 57 min [label]. ISPAD 2024 and US label give ~5-7 h duration, dose-dependent. No experience under 2 y [label]. Model: Loop fiasp; oref0 ultra-rapid peak 55, no delay [secondary]. PumpCart: active supply problem from 2025-04-10 to 2027-02-28, stop announced for 2026 [label]."
  },
  {
    "id": "lyumjev",
    "inn": "insulin lispro",
    "class": "ultra_rapid",
    "brands": ["Lyumjev", "Liumjev", "Lyumjev KwikPen", "Lyumjev Junior KwikPen", "Lyumjev Tempo Pen"],
    "aliases": ["lumjev", "lyumjeb", "lioumjev", "lioumjef", "lumyev", "liumyev", "lispro ultra rapide", "lispro ultrarrapida", "urli"],
    "onsetMin": 20,
    "peakMinLow": 60,
    "peakMinHigh": 180,
    "durationHLow": 5,
    "durationHHigh": 5,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": 55,
    "modelDurationMin": 360,
    "modelDelayMin": 10,
    "marketedSpain": false,
    "notes": "Onset 20 min, peak 1-3 h, duration 5 h from a 15 unit clamp [label]. ISPAD 2024 ~15-17 min, ~2-3 h, ~5-7 h. Only IV half-life published, 44 min [label]. U200 not established under 18 y [label]. Model: Loop lyumjev; AAPS uses peak 45 [secondary]. Not marketed in Spain; marketed in France."
  },
  {
    "id": "novorapid",
    "inn": "insulin aspart",
    "class": "rapid",
    "brands": ["NovoRapid", "NovoLog", "NovoRapid FlexPen", "NovoRapid Penfill", "NovoRapid PumpCart"],
    "aliases": ["novo rapid", "novorapide", "novo rapide", "novorrapid", "novo rapido", "novolog", "novo log"],
    "onsetMin": 10,
    "peakMinLow": 60,
    "peakMinHigh": 180,
    "durationHLow": 3,
    "durationHHigh": 5,
    "halfLifeH": 1.35,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": 75,
    "modelDurationMin": 360,
    "modelDelayMin": 10,
    "marketedSpain": true,
    "notes": "Onset 10-20 min, peak 1-3 h, duration 3-5 h [label]. Half-life 81 min [label, US]; EU label publishes none. Model is Loop rapidActingAdult; rapidActingChild is tp 65, td 360, delay 10. oref0 rapid-acting peak 75, no delay [secondary]."
  },
  {
    "id": "humalog",
    "inn": "insulin lispro",
    "class": "rapid",
    "brands": ["Humalog", "Humalog KwikPen", "Humalog Junior KwikPen", "Liprolog"],
    "aliases": ["umalog", "humalogue", "humalogo", "humalog junior", "humalog 200", "liprologue"],
    "onsetMin": 15,
    "peakMinLow": 60,
    "peakMinHigh": 120,
    "durationHLow": 2,
    "durationHHigh": 5,
    "halfLifeH": 1,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": 75,
    "modelDurationMin": 360,
    "modelDelayMin": 10,
    "marketedSpain": true,
    "notes": "Onset ~15 min, duration 2-5 h [label]. Peak 1-2 h [guideline]; EU label gives only PK 30-70 min. Half-life 1 h [label, US]. Label says adults and children, no numeric limit; ISPAD says lispro is indicated regardless of age. Junior KwikPen steps 0.5 unit [label]. U200 is reserved for over 20 units/day [label]. Model is Loop rapidActingAdult; child tp 65 [secondary]."
  },
  {
    "id": "insulin_lispro_sanofi",
    "inn": "insulin lispro",
    "class": "rapid",
    "brands": ["Insulin lispro Sanofi", "Insulina lispro Sanofi", "Insuline lispro Sanofi", "Admelog"],
    "aliases": ["admelogue", "lispro sanofi"],
    "onsetMin": 15,
    "peakMinLow": 60,
    "peakMinHigh": 120,
    "durationHLow": 2,
    "durationHHigh": 5,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Biosimilar. Onset ~15 min, duration 2-5 h [label]. Peak 1-2 h from ISPAD lispro row [guideline]. Admelog is the US name [label, US]; it has no EMA record. No CIMA or BDPM record."
  },
  {
    "id": "bysumlog",
    "inn": "insulin lispro",
    "class": "rapid",
    "brands": ["Bysumlog"],
    "aliases": ["bisumlog", "bysum log", "bisumlogue"],
    "onsetMin": 15,
    "peakMinLow": 60,
    "peakMinHigh": 120,
    "durationHLow": 2,
    "durationHHigh": 5,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Sandoz biosimilar, authorised 2026. Onset ~15 min, duration 2-5 h [label]. Peak 1-2 h from ISPAD lispro row [guideline]. In CIMA since 2026-06-19, not marketed."
  },
  {
    "id": "apidra",
    "inn": "insulin glulisine",
    "class": "rapid",
    "brands": ["Apidra", "Apidra SoloStar"],
    "aliases": ["appidra", "apidrá", "glulisine", "glulisina", "insuline glulisine", "insulina glulisina"],
    "onsetMin": 10,
    "peakMinLow": 90,
    "peakMinHigh": 90,
    "durationHLow": 4,
    "durationHHigh": 4,
    "halfLifeH": 0.7,
    "steadyStateDays": null,
    "minAgeYears": 6,
    "modelPeakMin": 75,
    "modelDurationMin": 360,
    "modelDelayMin": 10,
    "marketedSpain": true,
    "notes": "Onset 10-20 min, half-life 42 min, IQR 37-75 min [label]. Duration about 4 h from the leaflet [label]; ISPAD ~5.3 h. Peak 1.5 h [guideline]; EU label gives PK 55 min. Model is Loop rapidActingAdult; child tp 65 [secondary]."
  },
  {
    "id": "insulin_aspart_sanofi",
    "inn": "insulin aspart",
    "class": "rapid",
    "brands": ["Insulin aspart Sanofi", "Insuline asparte Sanofi", "Insulina aspart Sanofi", "Trurapi"],
    "aliases": ["tru rapi", "asparte sanofi", "aspart sanofi"],
    "onsetMin": 10,
    "peakMinLow": 60,
    "peakMinHigh": 180,
    "durationHLow": 3,
    "durationHHigh": 5,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Biosimilar. Values [label]. Trurapi is the Canadian name [secondary]; it is not an EU name. No CIMA record. Marketed in France as Insuline asparte Sanofi."
  },
  {
    "id": "kirsty",
    "inn": "insulin aspart",
    "class": "rapid",
    "brands": ["Kirsty", "Kixelle"],
    "aliases": ["kirsti", "kixel"],
    "onsetMin": 10,
    "peakMinLow": 60,
    "peakMinHigh": 180,
    "durationHLow": 3,
    "durationHHigh": 5,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Biosimilar, previously Kixelle. Values [label]. No CIMA or BDPM record."
  },
  {
    "id": "dazparda",
    "inn": "insulin aspart",
    "class": "rapid",
    "brands": ["Dazparda"],
    "aliases": ["dasparda", "daz parda", "dazparta"],
    "onsetMin": 10,
    "peakMinLow": 60,
    "peakMinHigh": 180,
    "durationHLow": 3,
    "durationHHigh": 5,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Sandoz biosimilar, authorised 2026. Values [label]. In CIMA since 2026-06-19, not marketed."
  },
  {
    "id": "actrapid",
    "inn": "human insulin",
    "class": "regular",
    "brands": ["Actrapid", "Actrapid InnoLet", "Actrapid FlexPen", "Actrapid Penfill"],
    "aliases": ["actrapide", "actra pid", "act rapid", "actrapit"],
    "onsetMin": 30,
    "peakMinLow": 90,
    "peakMinHigh": 210,
    "durationHLow": 7,
    "durationHHigh": 8,
    "halfLifeH": 5,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "Within 30 min, 1.5-3.5 h, ~7-8 h, terminal half-life ~2-5 h [label]. ISPAD regular: 30-60 min, 2-4 h, 5-8 h. Spain: vial only. Label says can be used in children and adolescents, no numeric limit."
  },
  {
    "id": "humulina_regular",
    "inn": "human insulin",
    "class": "regular",
    "brands": ["Humulina Regular", "Humulin R", "Umuline Rapide"],
    "aliases": ["humulina r", "humulin regular", "humuline rapide", "umulina regular", "umuline rapid"],
    "onsetMin": 30,
    "peakMinLow": 120,
    "peakMinHigh": 240,
    "durationHLow": 5,
    "durationHHigh": 8,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "CIMA sheet gives a graph, no figures; values are the ISPAD regular insulin class [guideline]. Sheet: paediatric data not available. Spain: vial. France: Umuline Rapide stopped 30/04/2026 [label]."
  },
  {
    "id": "insuman_rapid",
    "inn": "human insulin",
    "class": "regular",
    "brands": ["Insuman Rapid"],
    "aliases": ["insuman rapide", "insuman rapida", "insumann rapid"],
    "onsetMin": 30,
    "peakMinLow": 60,
    "peakMinHigh": 240,
    "durationHLow": 7,
    "durationHHigh": 9,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Values [label]. Authorised in the EU, but every Spanish entry is not marketed and BDPM has no record."
  },
  {
    "id": "insulatard",
    "inn": "isophane human insulin",
    "class": "nph",
    "brands": ["Insulatard", "Insulatard FlexPen", "Protaphane"],
    "aliases": ["insulatar", "insulatarde", "protafan", "protaphan"],
    "onsetMin": 90,
    "peakMinLow": 240,
    "peakMinHigh": 720,
    "durationHLow": 24,
    "durationHHigh": 24,
    "halfLifeH": 10,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "Within 1.5 h, 4-12 h, ~24 h, terminal half-life ~5-10 h [label]. ISPAD NPH: 2-4 h, 4-12 h, 12-24 h. Spain: vial and FlexPen; AEMPS announced the FlexPen stop for 2026 [label]. France: vial only."
  },
  {
    "id": "humulina_nph",
    "inn": "isophane human insulin",
    "class": "nph",
    "brands": ["Humulina NPH", "Humulina NPH KwikPen", "Humulin N", "Umuline NPH"],
    "aliases": ["humulin nph", "humulina n", "humuline nph", "umulina nph"],
    "onsetMin": 120,
    "peakMinLow": 240,
    "peakMinHigh": 720,
    "durationHLow": 12,
    "durationHHigh": 24,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "CIMA sheet gives a graph, no figures; values are the ISPAD NPH class [guideline]. Sheet: paediatric data not available. Spain: vial, KwikPen. France: KwikPen only."
  },
  {
    "id": "insuman_basal",
    "inn": "isophane human insulin",
    "class": "nph",
    "brands": ["Insuman Basal"],
    "aliases": ["insuman basale", "insuman basal solostar"],
    "onsetMin": 60,
    "peakMinLow": 180,
    "peakMinHigh": 240,
    "durationHLow": 11,
    "durationHHigh": 20,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Values [label]. Same drug class as Insulatard but a different published profile. Not marketed in Spain, no BDPM record."
  },
  {
    "id": "lantus",
    "inn": "insulin glargine",
    "class": "long",
    "brands": ["Lantus", "Lantus SoloStar"],
    "aliases": ["lantús", "lantuss", "lentus", "lanthus", "lantos", "lantus solo star"],
    "onsetMin": 120,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 22,
    "durationHHigh": 24,
    "halfLifeH": null,
    "steadyStateDays": 4,
    "minAgeYears": 2,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "U100. EU label gives no onset or duration figure, calls it peakless, steady state 2-4 days [label]. Onset 2-4 h, duration ~22-24 h, 8-12 h no pronounced peak [guideline]. Half-life not in labels; 12-14 h in a review [secondary]."
  },
  {
    "id": "abasaglar",
    "inn": "insulin glargine",
    "class": "long",
    "brands": ["Abasaglar", "Abasaglar KwikPen", "Basaglar", "Abasria"],
    "aliases": ["abaglar", "abazaglar", "abasaglár"],
    "onsetMin": 120,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 22,
    "durationHHigh": 24,
    "halfLifeH": null,
    "steadyStateDays": 4,
    "minAgeYears": 2,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "U100 biosimilar. Steady state 2-4 days [label]. Onset and duration from the ISPAD glargine row, which covers biosimilars [guideline]."
  },
  {
    "id": "semglee",
    "inn": "insulin glargine",
    "class": "long",
    "brands": ["Semglee"],
    "aliases": ["semgli", "semgly", "semgle", "sem glee"],
    "onsetMin": 120,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 22,
    "durationHHigh": 24,
    "halfLifeH": null,
    "steadyStateDays": 4,
    "minAgeYears": 2,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "U100 biosimilar. Steady state 2-4 days [label]. Onset and duration from the ISPAD glargine row [guideline]. Marketed in Spain and France."
  },
  {
    "id": "ondibta",
    "inn": "insulin glargine",
    "class": "long",
    "brands": ["Ondibta"],
    "aliases": ["ondipta", "on dibta"],
    "onsetMin": 120,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 22,
    "durationHHigh": 24,
    "halfLifeH": null,
    "steadyStateDays": 4,
    "minAgeYears": 2,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "U100 biosimilar (Sandoz), authorised 2026. Steady state 2-4 days [label]. Onset and duration from the ISPAD glargine row [guideline]. In CIMA since 2026-03-09, not marketed."
  },
  {
    "id": "levemir",
    "inn": "insulin detemir",
    "class": "long",
    "brands": ["Levemir", "Levemir FlexPen", "Levemir Penfill", "Levemir InnoLet"],
    "aliases": ["lévémir", "lévemir", "levémir", "levemire", "lebemir", "detemir", "détémir", "insuline détémir", "insulina detemir"],
    "onsetMin": 60,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 20,
    "durationHHigh": 24,
    "halfLifeH": 7,
    "steadyStateDays": null,
    "minAgeYears": 1,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Onset 1-2 h and duration floor 20 h [guideline]. Up to 24 h, half-life 5-7 h, PK 6-8 h, steady state after 2-3 doses if twice daily [label]. Peak left null: over 50% of maximum effect from 3-4 h to ~14 h [label]. Not marketed in Spain. France: stop by 31/12/2026 [secondary]."
  },
  {
    "id": "toujeo",
    "inn": "insulin glargine",
    "class": "ultra_long",
    "brands": ["Toujeo", "Toujeo SoloStar", "Toujeo DoubleStar", "Optisulin"],
    "aliases": ["toujéo", "tujeo", "tujéo", "toujo", "tou jeo", "tout jeu", "tuyeo", "glargine 300", "glargina 300", "glargine u300", "gla-300"],
    "onsetMin": 120,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 24,
    "durationHHigh": 36,
    "halfLifeH": 19,
    "steadyStateDays": 4,
    "minAgeYears": 6,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "U300. Beyond 24 h up to 36 h, half-life 18-19 h, steady state 3-4 days [label]. Onset 2-6 h [guideline]. US: steady state by at least 5 days. Injection window plus or minus 3 h [label]. Class ultra_long here because the label duration exceeds 24 h; ISPAD names only degludec ultra-long."
  },
  {
    "id": "tresiba",
    "inn": "insulin degludec",
    "class": "ultra_long",
    "brands": ["Tresiba", "Tresiba FlexTouch", "Tresiba Penfill", "Tresiba FlexPen"],
    "aliases": ["trésiba", "tressiba", "tresibá", "tresiva", "trésiva", "tre siba", "très iba", "trecibas", "tresiba 100", "tresiba 200", "degludec", "dégludec", "degludek", "deglutec", "insuline dégludec", "insulina degludec"],
    "onsetMin": 30,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 42,
    "durationHHigh": null,
    "halfLifeH": 25,
    "steadyStateDays": 3,
    "minAgeYears": 1,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "The 42 h insulin. Beyond 42 h, half-life ~25 h, steady state 2-3 days [label]; US label 3-4 days. Onset 30-90 min [guideline]. Minimum 8 h between injections; no experience with flexible timing in children [label]. U100 steps 1 unit, U200 steps 2 units, no conversion. Not for pumps [label]. Loop and oref0 have no model for it, so the model fields are null."
  },
  {
    "id": "awiqli",
    "inn": "insulin icodec",
    "class": "weekly",
    "brands": ["Awiqli"],
    "aliases": ["awikli", "awicli", "aouikli", "awi qli", "awiqly", "icodec", "insuline icodec", "insulina icodec"],
    "onsetMin": null,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 168,
    "durationHHigh": null,
    "halfLifeH": 168,
    "steadyStateDays": 28,
    "minAgeYears": 18,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "700 U/mL. Covers a full week, half-life ~1 week, clinical steady state 2-4 weeks, or 2-3 with the one-off extra dose [label]. ISPAD: ~8 days. Adults only. Type 1: higher hypoglycaemia risk than degludec [label]. In CIMA since 2026-06-15, not marketed."
  },
  {
    "id": "onswik",
    "inn": "insulin efsitora alfa",
    "class": "weekly",
    "brands": ["Onswik"],
    "aliases": ["onswick", "onsuik", "efsitora", "efsitora alfa", "basal insulin fc"],
    "onsetMin": null,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": null,
    "durationHHigh": null,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Listed so the name resolves. CHMP positive opinion 25/06/2026 for type 2 diabetes; CIMA lists 500 and 1000 U/mL from 2026-09-01, not marketed [label]. Product information was not retrievable, so all numbers are null. Not indicated in type 1."
  },
  {
    "id": "novomix",
    "inn": "biphasic insulin aspart",
    "class": "premix",
    "brands": ["NovoMix 30", "NovoMix 50", "NovoMix 70"],
    "aliases": ["novo mix", "novomixte", "novomix flexpen", "novomix 30 flexpen"],
    "onsetMin": 10,
    "peakMinLow": 60,
    "peakMinHigh": 240,
    "durationHLow": null,
    "durationHHigh": 24,
    "halfLifeH": 9,
    "steadyStateDays": null,
    "minAgeYears": 10,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "Onset 10-20 min, peak 1-4 h, up to 24 h, half-life 8-9 h for NovoMix 30 [label]. Min age 10 is NovoMix 30; NovoMix 50 is adults only [label]. Spain: 30 FlexPen only. France: stop of 50 FlexPen by 31/12/2026 [secondary]."
  },
  {
    "id": "humalog_mix",
    "inn": "biphasic insulin lispro",
    "class": "premix",
    "brands": ["Humalog Mix25", "Humalog Mix50"],
    "aliases": ["humalog mix 25", "humalog mix 50", "humalog mix", "humalogue mix"],
    "onsetMin": 15,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": null,
    "durationHHigh": null,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "Onset ~15 min for the lispro part [label]. Protamine part similar to NPH, profile over ~15 h; no duration figure, so null [label]. Under 12 y only if an expected benefit over soluble insulin [label]."
  },
  {
    "id": "mixtard",
    "inn": "biphasic human insulin 30/70",
    "class": "premix",
    "brands": ["Mixtard 30", "Actraphane 30"],
    "aliases": ["mixtard", "mistard", "mixtarde", "actraphane", "actrafan"],
    "onsetMin": 30,
    "peakMinLow": 120,
    "peakMinHigh": 480,
    "durationHLow": null,
    "durationHHigh": 24,
    "halfLifeH": 10,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "Within 30 min, 2-8 h, up to 24 h, terminal half-life ~5-10 h [label]. Spain and France: vial only. Label says can be used in children and adolescents, no numeric limit."
  },
  {
    "id": "humulina_30_70",
    "inn": "biphasic human insulin 30/70",
    "class": "premix",
    "brands": ["Humulina 30:70", "Humulina 30:70 KwikPen", "Umuline Profil 30"],
    "aliases": ["humulina 30 70", "humulina treinta setenta", "umuline profil", "umuline 30", "humulin 30/70"],
    "onsetMin": null,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": null,
    "durationHHigh": null,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": true,
    "notes": "CIMA sheet gives a graph only and ISPAD has no premix row, so all numbers are null. Sheet: paediatric data not available. Spain: vial, KwikPen. France: Umuline Profil 30 KwikPen only."
  },
  {
    "id": "insuman_comb",
    "inn": "biphasic human insulin",
    "class": "premix",
    "brands": ["Insuman Comb 15", "Insuman Comb 25", "Insuman Comb 30", "Insuman Comb 50"],
    "aliases": ["insuman combi", "insuman comb"],
    "onsetMin": 30,
    "peakMinLow": 90,
    "peakMinHigh": 240,
    "durationHLow": 11,
    "durationHHigh": 20,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": null,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Envelope of the four strengths; each differs, see the table [label]. Not marketed in Spain, no BDPM record."
  },
  {
    "id": "ryzodeg",
    "inn": "insulin degludec + insulin aspart",
    "class": "premix",
    "brands": ["Ryzodeg"],
    "aliases": ["rizodeg", "ryzodec", "degludec aspart"],
    "onsetMin": null,
    "peakMinLow": null,
    "peakMinHigh": null,
    "durationHLow": 24,
    "durationHHigh": null,
    "halfLifeH": 25,
    "steadyStateDays": 3,
    "minAgeYears": 2,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "70% degludec, 30% aspart. Beyond 24 h, degludec half-life 25 h, steady state 2-3 days [label]. Not marketed in Spain, no BDPM record."
  },
  {
    "id": "truvelog_mix_30",
    "inn": "biphasic insulin aspart",
    "class": "premix",
    "brands": ["Truvelog Mix 30"],
    "aliases": ["truvelog", "truvelog mix", "truvelog 30"],
    "onsetMin": 10,
    "peakMinLow": 60,
    "peakMinHigh": 240,
    "durationHLow": null,
    "durationHHigh": 24,
    "halfLifeH": null,
    "steadyStateDays": null,
    "minAgeYears": 10,
    "modelPeakMin": null,
    "modelDurationMin": null,
    "modelDelayMin": null,
    "marketedSpain": false,
    "notes": "Withdrawn in the EU 25/01/2024 [label]. Listed only so an old name resolves. Values from its last label."
  }
]
```

## 4. Switching rules: Lantus to Tresiba in a child

### Dose at the switch

| Source | Rule |
|---|---|
| EU label, type 1 | "a dose reduction of 20% based on the previous basal insulin dose ... should be considered", then individual adjustment on glycaemic response [label] |
| EU label, children | "dose reduction of basal and bolus insulin needs to be considered on an individual basis" [label] |
| EU label, type 2 | Unit-to-unit from once-daily basal. This is where "unit-for-unit" comes from [label] |
| CIMA (Spanish sheet) | Same text as the EU label, checked for type 1 and children [label] |
| US label, children from 1 y | Start at 80% of the total daily long or intermediate-acting dose [label, US] |
| US label, adults | Start at the same unit dose [label, US] |
| ISPAD 2024 | No glargine-to-degludec dose rule. Dose changes "every 3-4 days" [guideline] |
| ISPAD 2022 | "(100%-150% of the glargine dose)" from small studies. This sentence is gone in 2024 [guideline] |

**Main rule.** In the EU, type 1 is not unit-for-unit by default. Consider starting 20% below the Lantus dose, and for a child also consider reducing the bolus. The label frames this as individual, so the team sets the number. Close glucose monitoring is recommended during the transfer and for the following weeks [label].

The label sets a cautious start, not the final dose. In the paediatric cohort below, the degludec dose was 12.5% higher at 12 months [study]. A rise in the dose after a reduced start should not surprise the app.

### First 2–3 days

- No paediatric study reports glucose day by day after a switch. A PubMed search of 2026-11-06 for degludec, glargine and switching with first-day terms returned no record.
- No label says how to sequence the last Lantus and first Tresiba doses. There is no overlap instruction [label].
- Keep the same injection time every day until steady state, and correct highs with bolus doses [secondary, Novo Nordisk funded review].
- Adults, same dose, supper injection, days 5–6 against days 1–2: mean glucose 142.6 vs 143.1 mg/dL, higher from 19:30 to 22:30, lower from 06:30 to 08:00, no change in time below 70 mg/dL. 16 patients analysed, mean age 53.9 y. The authors note steady state may not yet have been reached [study].
- Seven adults moved from twice-daily basal to degludec at 80–90% of the dose: CGM profile unchanged at day 3 [study].

My inference, not tested in children: Lantus wanes at about 24 h while degludec is still building, so days 1–3 are more likely to run high than low. Hypoglycaemia risk grows as degludec reaches steady state, especially without a dose reduction.

Calculated from the 25 h half-life [label], assuming one compartment and 24 h dosing: trough exposure is about 49%, 74%, 86% and 93% of steady state after doses 1, 2, 3 and 4. This is arithmetic, not a published figure.

### When the dose can be judged

- Steady state: 2–3 days [label], 3–4 days [label, US].
- Change the dose no more often than every 3–4 days [guideline], [label, US]. Weekly is practical, except that fasting hypoglycaemia calls for a reduction without waiting [secondary, Novo Nordisk funded review].
- Judge on fasting glucose [label]. BEGIN Young titrated weekly on the lowest pre-breakfast value of the previous 3 days [study].
- Meal ratios can move too. See the Tumini row below.

### Morning or bedtime

- The label says any time of day, preferably the same time. Children: no clinical experience with flexible timing [label].
- ISPAD: in children degludec "is generally given at the same time of the day" [guideline]. It does not prefer morning or evening.
- For glargine only: before breakfast, before dinner or at bedtime has equal effect, but nocturnal hypoglycaemia occurs "significantly less often with breakfast injection" [guideline].
- Paediatric switch studies used evening or bedtime injections [study]. No paediatric morning-versus-evening comparison of degludec was found.
- No source gives a rule for moving the injection time on the switch day itself.

### Exercise

- Label: unplanned strenuous exercise may cause hypoglycaemia, and dose changes may be needed with increased activity [label].
- ISPAD 2024: at regular doses glargine U300 can give significantly less hypoglycaemia after exercise than degludec. This is "negated" with 75% of the basal dose [guideline, adult data].
- ISPAD 2022: a 20% cut in background insulin works for adults on injections. 45 min of midday exercise needs no basal change. The effect of exercise on absorption of ultra-long insulin "is unclear" [guideline].
- Adults, 30 min moderate exercise: risk similar to glargine, 18 vs 23 events in 24 h [study].
- Adults, 5 exercise days: 75% dose started 3 days before gave more time in range, 4008 vs 3566 min [study].
- Adults: time below 70 after exercise was 4.37% on degludec vs 2.71% on U300, and 2.55% vs 2.28% at 75% dose on exercise days [study].
- Adolescents 13–17 y at a camp: 20% basal cut the evening before plus 50% meal insulin cut gave no time below 54 mg/dL. Only 11 were on degludec, and the study is observational and described as preliminary [study].
- Same-day basal cuts do not work on degludec. Change it 3 days ahead, otherwise use carbohydrate and bolus [secondary, Novo Nordisk funded review]. The camp study above disputes this.

### Sick days

- Illness usually raises insulin need. Rapid-acting insulin is recommended for severe hyperglycaemia [label].
- "Never completely stop insulin" [guideline, 2022].
- Hyperglycaemic illness: basal may need +20–30%. If illness is expected to last 3 days or more, consider +10–20% [guideline, 2022].
- Gastrointestinal illness with hypoglycaemia: cut total daily dose 20–50%, generally starting with −20% basal and −50% bolus [guideline, 2022].
- That chapter never mentions degludec [guideline, 2022]. A degludec change takes 48–72 h to have clinical effect [secondary, Novo Nordisk funded review], so my inference is that same-day basal changes will not act that day. Same-day control rests on bolus, carbohydrate and the team's advice.
- Ketosis: 0.68 vs 1.09 episodes per patient-year against detemir [label]. Real-world DKA data are mixed (see section 5).
- Case report: boy of 13, DKA with acute kidney injury. Repeated hypoglycaemia needed basal to be stopped for 8 days [study, single case].

### Hypoglycaemia and the long tail

- Label: "the prolonged effect of Tresiba may delay recovery from hypoglycaemia". It says "as with other basal insulin products", and the Lantus label carries the same warning [label].
- Adults given 3 times the usual dose: recovery rate similar to glargine [study].
- Degludec was detectable for at least 72 h after a single dose in children, adolescents and adults [study].
- Single-dose exposure tended to be higher in children than adults, ratio 1.48 (CI 0.98–2.24, not significant) [study]. At steady state it was comparable [label].
- Overdose case: 242 units against a usual 32, four days in hospital, no documented hypoglycaemia under proactive care [study, single case].
- Calculated from the 25 h half-life [label]: after the last dose, about 50% remains at 25 h, 25% at 50 h, 12.5% at 75 h. This is arithmetic, not a published figure.

### Paediatric evidence

| Study | Who | Switch or comparison | Result |
|---|---|---|---|
| BEGIN Young, Thalange 2015 [study] | 350 aged 1–17 y, 70 of 174 on degludec aged 6–11 y | Degludec vs detemir, 52 weeks. Split recalculated "with no basal dose reduction" | HbA1c 7.9 vs 7.8%. Basal 0.38 vs 0.55 U/kg. Severe hypoglycaemia 0.51 vs 0.33 per patient-year, not significant. Ketosis lower |
| EU label on that trial [label] | Same | Age groups | Ages 6–11 y had numerically more confirmed hypoglycaemia in both arms, and numerically more severe hypoglycaemia on Tresiba |
| Urakami 2017 [study] | 18 children, 11.0 ± 0.5 y, glargine at bedtime | Crossover, 24 weeks, started at the same dose | FPG and HbA1c unchanged. Nocturnal hypoglycaemia fell. No severe event |
| Predieri 2018 [study] | 37 aged 11.7 ± 4.2 y, evening or bedtime injection | Retrospective, 1 year. Start 60–150% of glargine dose in 26 patients | Degludec +12.5%, meal insulin −11.6%. No severe hypoglycaemia |
| Tumini 2020 [study] | 51 aged 13.8 ± 4.6 y | Retrospective, 6 months | Grams per unit fell at lunch (−1.29) and dinner (−3.08), rose at breakfast (+1.37). So more insulin per gram at dinner, on my reading of the units. No severe hypoglycaemia or DKA |
| Rabbone 2025, ISPED CARD [study] | 1063 children from first-generation basal, 706 matched | Registry, Sanofi supported | HbA1c ~8.7 to ~7.4% with U300 or degludec. Hypoglycaemia not assessable |
| onset 7, Bode 2019 [study] | 777 aged 1 to <18 y | Fiasp vs aspart, both with degludec, 26 weeks | Mealtime Fiasp better on HbA1c by 0.17%. No excess hypoglycaemia. This is the child's future combination |
| Biester 2014 [study] | 12 children 6–11 y, 13 adolescents, 12 adults | Single 0.4 U/kg dose | Ultra-long profile preserved |

### Other switches, for reference

| From | To | Rule |
|---|---|---|
| Lantus | Toujeo | Unit-to-unit; 10–18% more may be needed. Not bioequivalent [label] |
| Toujeo | Lantus, Abasaglar, Semglee | About −20% [label] |
| Toujeo | Tresiba | Type 2: consider −20%. Type 1: consider −20% [label] |
| Twice-daily basal | Toujeo | 80% of the previous total [label] |
| Twice-daily NPH | Lantus | −20 to −30% during the first weeks [label] |
| NPH | Glargine | About −20% [guideline] |
| Daily basal | Awiqli (adults) | First dose the day after the last daily dose; daily dose × 7; type 1 first dose × 1.5 [label] |
| Degludec | Pump | Reduce pump basal by ~20% for the first 1–2 days [guideline] |
| Another mealtime insulin | Lyumjev | Unit-to-unit [label] |
| Tresiba U100 | Tresiba U200 | No conversion [label] |

## 5. Contradictions between sources

Each item names its sources. EU and US labels are [label], ISPAD is [guideline], named studies are [study], and Loop, oref0, AAPS, the Novo Nordisk funded review and news are [secondary].

**Switching and use of degludec**

1. Steady state: 2–3 days in the EU label and Heise 2016; 3–4 days in the US label. JSON uses 3.
2. Adults with type 1: EU says consider −20%; US says same unit dose.
3. Children: EU says individual; US says 80%; BEGIN Young used "no basal dose reduction"; Urakami used 100%; Predieri 60–150%; ISPAD 2022 cites 100–150%; ISPAD 2024 is silent.
4. A Novo Nordisk funded review advises "up to 20%" less, yet also suggests "a slightly higher dose of degludec on the first day of switch" when timing varies.
5. Missed dose in a child: EU says take on discovery; US says contact the team and monitor until the next scheduled dose.
6. Timing in children: the EU label reports no clinical experience with flexibility. ISPAD 2024 says degludec "should allow children to have a less stringent timing", and also says it is generally given at the same time.
7. Basal cut before exercise: 3 days ahead (Novo Nordisk funded review, Moser 2019) against the evening before (Rabbone 2025) against on exercise days (Moser 2023).
8. Meal insulin after the switch: the review cut the evening bolus (1:20 to 1:25). Tumini points to more insulin per gram at dinner. Kuroda suggests a larger supper bolus. Predieri found total meal insulin −11.6%.
9. Recovery from hypoglycaemia: labels say "may delay"; Koehler 2014 found recovery similar to glargine, in adults only.
10. DKA protection: BEGIN Young rate ratio 0.41 and Schmitt 2019 fewer admissions. Vakharia 2025 not significant overall. Nally 2023 17.2% vs 9.0%, p=0.3.
11. Hypoglycaemia in children: ISPAD reports no significant difference, but the EU label flags numerically more severe events on Tresiba at ages 6–11 y, the age band of this child.

**Time-action numbers**

12. Fiasp duration: 3–5 h (EU label, ISPAD 2022), ~5–7 h (ISPAD 2024, US at 0.1–0.4 U/kg), 6 h plus 10 min delay (Loop). The ISPAD 2024 range matches the US dose table.
13. Fiasp peak: 1–3 h (EU), ~1.5–2.2 h (ISPAD 2024), ~91–133 min (US), 55 min (Loop, oref0). The model value is a curve parameter.
14. Fiasp onset: relative only (EU), 5–20 min (ISPAD 2024), 6–12 min (ISPAD 2022), ~16–20 min (US).
15. Fiasp half-life: 57 min "comparable to NovoRapid" (EU), ~1.1 h (US Fiasp), 81 min (US NovoLog).
16. Lyumjev: onset 20 min (EU) vs ~15–17 min (ISPAD, US); duration 5 h (EU) vs ~5–7 h (ISPAD) vs ~4.6–7.3 h (US).
17. Lyumjev model peak: 55 min (Loop) vs 45 min (AAPS). oref0 has no Lyumjev curve.
18. Lispro: onset ~15 min (EU) vs 15–30 min (ISPAD); duration 2–5 h vs ≤5 h; PK peak 30–70 min (EU) vs 30–90 min (US).
19. Glulisine: onset 10–20 min (EU) vs 12–30 min (ISPAD); duration ~4 h (leaflet) vs ~5.3 h (ISPAD).
20. Aspart onset: 10–20 min (EU), 15 min (ISPAD 2024), 9–21 min (ISPAD 2022).
21. Regular insulin: Actrapid ~7–8 h, Insuman Rapid 7–9 h, ISPAD 5–8 h. Peak 1.5–3.5, 1–4 and 2–4 h.
22. NPH: Insulatard ~24 h, Insuman Basal 11–20 h, ISPAD 12–24 h, US Lantus label median 14.5 h. Peak 4–12 h vs 3–4 h.
23. Glargine U100 peak: "peakless" (EU), "8–12 h, no pronounced peak" (ISPAD 2024), 8–12 h unqualified (ISPAD 2022).
24. Toujeo steady state: 3–4 days (EU), at least 5 days (US), full effect at least 3–5 days (ISPAD 2024). The 36 h ceiling is the end of the clamp observation, not a measured end of action.
25. Icodec half-life: ~1 week (EU) vs ~8 days (ISPAD 2024).
26. Toujeo class: ISPAD names only degludec ultra-long. It is `ultra_long` here because its label duration exceeds 24 h. A stricter scheme would use `long`.

**Models**

27. Action duration: 360 min plus delay (Loop); user DIA with a 5 h minimum (oref0); 8 h default end time (AAPS). Delay: 10 min (Loop), none (oref0).
28. Children: Loop has a child preset (tp 65). oref0 has none.

**Names and status**

29. Trurapi: not an EU name. EMA lists "Insulin aspart Sanofi"; Trurapi is the Canadian name [secondary]. Admelog: US name; EMA lists "Insulin lispro Sanofi".
30. Levemir: BDPM still shows FlexPen and Penfill as marketed, while a French news report gives a stop by 31/12/2026 [secondary]. Spain already shows it as not marketed.
31. Fiasp FlexTouch: listed as short in the AEMPS note of January 2025, with no active flag in CIMA today. Fiasp PumpCart: stop announced for 2026, but the CIMA supply notice runs to 2027-02-28.
32. Onswik: "Opinion" in the EMA dataset, authorised 01/09/2026 in CIMA.
33. ISPAD 2024 cites reference 62 for degludec's EMA and FDA approval, but reference 62 is a growth-hormone paper. The approval statement itself matches the labels.

**Not verified**

- Spanish health-service funding of any product. CIMA shows marketing, not funding.
- An official French notice on the Levemir stop. Only a news report citing Vidal was read.
- Onswik's product information: the EMA and CIMA links returned 404.
- A SC half-life for Lantus in a label. The 12–14 h figure comes from a review table.
- Any AEMPS IPT for Tresiba alone. A web search found none, and the AEMPS index was not read in full.

## 6. Sources

Read on 2026-11-06.

**EMA product information** (`https://www.ema.europa.eu/en/documents/product-information/NAME-epar-product-information_en.pdf`, with NAME as below)

tresiba, toujeo, lantus, abasaglar, semglee, ondibta, levemir, awiqli, fiasp, lyumjev, novorapid, humalog, liprolog, insulin-lispro-sanofi, bysumlog, apidra, insulin-aspart-sanofi, kirsty, dazparda, actrapid, insuman, insulatard, protaphane, novomix, mixtard, actraphane, ryzodeg, truvelog-mix-30, kyinsu, xultophy, suliqua

- Tresiba example: https://www.ema.europa.eu/en/documents/product-information/tresiba-epar-product-information_en.pdf
- EMA medicines dataset: https://www.ema.europa.eu/en/documents/report/medicines-output-medicines_json-report_en.json
- Onswik: https://www.ema.europa.eu/en/medicines/human/EPAR/onswik

**Spain**

- Tresiba sheet: https://cima.aemps.es/cima/dochtml/ft/112807004/FT_112807004.html
- Humulina Regular: https://cima.aemps.es/cima/dochtml/ft/80664/FT_80664.html
- Humulina NPH: https://cima.aemps.es/cima/dochtml/ft/80667/FT_80667.html
- Humulina 30:70: https://cima.aemps.es/cima/dochtml/ft/80665/FT_80665.html
- Register by ATC: https://cima.aemps.es/cima/rest/medicamentos?atc=A10AB (also A10AC, A10AD, A10AE)
- Supply record: https://cima.aemps.es/cima/rest/psuministro/v2/cn/728514
- AEMPS note ICM (CONT) 01/2025: https://www.aemps.gob.es/informa/la-aemps-en-colaboracion-con-las-sociedades-medicas-implicadas-en-el-tratamiento-de-la-diabetes-emite-recomendaciones-de-uso-de-las-insulinas-de-accion-rapida/

**France**

- BDPM: https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt
- BDPM presentations: https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_CIP_bdpm.txt

**ISPAD**

- 2024 insulin chapter: https://doi.org/10.1159/000543169, PMID https://pubmed.ncbi.nlm.nih.gov/39884261/. The publisher blocked automated access, so the text was read from a third-party copy of the journal PDF, https://endoinfo.ru/guidelines/4_ispad.pdf. Citation and abstract match PubMed. Table 1 was read from the rendered page.
- 2022 insulin chapter: https://doi.org/10.1111/pedi.13442, read at https://ispad.org/asset/683E33FD%2D2575%2D46E6%2D854DE074E692451E
- 2022 sick days: https://doi.org/10.1111/pedi.13415, read at https://ispad.org/asset/6551D05A%2D156C%2D4772%2DA32A6D663FCFC2D4
- 2022 exercise: https://pmc.ncbi.nlm.nih.gov/articles/PMC10107219/

**Open-source code, pinned commits**

- Loop presets: https://github.com/LoopKit/LoopKit/blob/b5c5cfbd2d9f400fc47bea437450c6a793d18eb6/LoopKit/Insulin/ExponentialInsulinModelPreset.swift
- Loop model selection: https://github.com/LoopKit/LoopKit/blob/b5c5cfbd2d9f400fc47bea437450c6a793d18eb6/LoopKit/Insulin/InsulinModelProvider.swift
- Loop curve: https://github.com/LoopKit/LoopAlgorithm/blob/e692e7708ccb5f53ec89dd53fea335fff4b38f4f/Sources/LoopAlgorithm/Insulin/ExponentialInsulinModel.swift
- Same presets in LoopAlgorithm: https://github.com/LoopKit/LoopAlgorithm/blob/e692e7708ccb5f53ec89dd53fea335fff4b38f4f/Sources/LoopAlgorithm/Insulin/ExponentialInsulinModelPreset.swift
- oref0 curves: https://github.com/openaps/oref0/blob/88cf032aa74ff25f69464a7d9cd601ee3940c0b3/lib/iob/total.js
- oref0 maths: https://github.com/openaps/oref0/blob/88cf032aa74ff25f69464a7d9cd601ee3940c0b3/lib/iob/calculate.js
- oref0 `dev` at d219baf gives the same constants.
- AAPS: https://github.com/nightscout/AndroidAPS/blob/f77abd9b82b308e8fc330da0d7a31370fb4a0f49/core/interfaces/src/commonMain/kotlin/app/aaps/core/interfaces/insulin/InsulinType.kt

**US labels**

- Tresiba: https://www.novo-pi.com/tresiba.pdf
- Fiasp: https://www.novo-pi.com/fiasp.pdf
- NovoLog: https://www.novo-pi.com/novolog.pdf
- Toujeo: https://products.sanofi.us/toujeo/toujeo.pdf
- Lantus: https://products.sanofi.us/lantus/lantus.pdf
- Lyumjev: https://pi.lilly.com/us/lyumjev-uspi.pdf
- Humalog, set id c8ecbd7a-0e22-4fc7-a503-faa58c1b6f3f, read through openFDA: https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=c8ecbd7a-0e22-4fc7-a503-faa58c1b6f3f
- Admelog, set id 0691def8-4a7b-4de3-866f-a280989f47f1: https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0691def8-4a7b-4de3-866f-a280989f47f1

**Studies**

- BEGIN Young, Thalange 2015: https://pubmed.ncbi.nlm.nih.gov/25683037/, full text https://pmc.ncbi.nlm.nih.gov/articles/PMC4413367/
- Urakami 2017: https://pubmed.ncbi.nlm.nih.gov/27746408/
- Predieri 2018: https://pmc.ncbi.nlm.nih.gov/articles/PMC6115523/
- Tumini 2020: https://pmc.ncbi.nlm.nih.gov/articles/PMC7170455/
- Rabbone 2025, ISPED CARD: https://pmc.ncbi.nlm.nih.gov/articles/PMC12662695/
- Rabbone 2025, exercise camp: https://pmc.ncbi.nlm.nih.gov/articles/PMC12587228/
- onset 7, Bode 2019: https://pubmed.ncbi.nlm.nih.gov/31076415/
- Biester 2014: https://pubmed.ncbi.nlm.nih.gov/24467565/
- Heise 2016, steady state: https://pubmed.ncbi.nlm.nih.gov/25581159/
- Koehler 2014: https://pubmed.ncbi.nlm.nih.gov/24057153/
- Heise 2016, exercise: https://pubmed.ncbi.nlm.nih.gov/26450456/
- Moser 2019: https://pubmed.ncbi.nlm.nih.gov/30221457/
- Moser 2023, ULTRAFLEXI-1: https://pubmed.ncbi.nlm.nih.gov/36516429/
- Kuroda 2017: https://pmc.ncbi.nlm.nih.gov/articles/PMC6224929/
- Nakae 2014: https://pubmed.ncbi.nlm.nih.gov/24838615/
- Thalange 2019, ketosis analysis: https://pubmed.ncbi.nlm.nih.gov/30666772/
- Schmitt 2019: https://pubmed.ncbi.nlm.nih.gov/31865335/
- Vakharia 2025: https://pubmed.ncbi.nlm.nih.gov/39829694/
- Nally 2023: https://pubmed.ncbi.nlm.nih.gov/37078999/
- Kawashima 2026: https://pubmed.ncbi.nlm.nih.gov/41923793/
- Thompson 2018: https://pubmed.ncbi.nlm.nih.gov/29887987/

**Secondary, flagged**

- Thalange 2019 narrative review, funded by Novo Nordisk with funded medical writing: https://pmc.ncbi.nlm.nih.gov/articles/PMC6612349/
- Caducée, 12/09/2026, citing Vidal, on Levemir, Fiasp PumpCart and NovoMix 50 in France: https://www.caducee.net/actualite-medicale/16959/arret-de-levemir-fiasp-pumpcart-et-victoza-fin-2026-comment-preparer-les-alternatives.html
- GaBI on Trurapi: https://www.gabionline.net/biosimilars/news/canada-approves-insulin-aspart-biosimilar-trurapi
