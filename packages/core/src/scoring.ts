import type { Condition, EffectiveConfig } from "./pack";
import type { LocalizedText } from "./i18n";

export interface CompanyForScoring {
  governorate?: string | null;
  city?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  industry?: string | null;
  subindustry?: string | null;
  verification_status?: string | null;
  attributes?: Record<string, unknown>;
}

export interface ScoreResult {
  /** Points earned from rules whose inputs are known */
  score: number;
  /** Maximum attainable from positive rules */
  maxScore: number;
  /** 0–100 */
  normalized: number;
  matched: { key: string; points: number; reason: LocalizedText }[];
  /** Rules that could not be evaluated because the input is unknown — prompts research, never counts against the lead */
  unknown: { key: string; field: string }[];
  /** Share of rules whose inputs are known (0–1): how much to trust the score */
  coverage: number;
}

function read(c: CompanyForScoring, field: string): unknown {
  if (field.startsWith("attributes.")) return c.attributes?.[field.slice(11)];
  return (c as Record<string, unknown>)[field];
}

const isUnknown = (v: unknown) => v === undefined || v === null || v === "";

function evaluate(cond: Condition, v: unknown, territories: string[]): boolean | "unknown" {
  if (cond.op === "present") return !isUnknown(v);
  if (isUnknown(v)) return "unknown";
  switch (cond.op) {
    case "eq":
      return v === cond.value;
    case "in":
      return Array.isArray(v) ? v.some((x) => cond.value.includes(String(x))) : cond.value.includes(String(v));
    case "gte":
      return typeof v === "number" && v >= cond.value;
    case "lte":
      return typeof v === "number" && v <= cond.value;
    case "in_territory":
      return territories.length === 0 ? "unknown" : territories.includes(String(v));
  }
}

/** Explainable, deterministic fit score. No AI involved; unknown data is reported, never assumed. */
export function scoreCompany(cfg: EffectiveConfig, company: CompanyForScoring): ScoreResult {
  let score = 0;
  let maxScore = 0;
  const matched: ScoreResult["matched"] = [];
  const unknown: ScoreResult["unknown"] = [];
  for (const rule of cfg.scoring) {
    if (rule.points > 0) maxScore += rule.points;
    const r = evaluate(rule.when, read(company, rule.when.field), cfg.territories);
    if (r === "unknown") unknown.push({ key: rule.key, field: rule.when.field });
    else if (r) {
      score += rule.points;
      matched.push({ key: rule.key, points: rule.points, reason: rule.reason });
    }
  }
  const total = cfg.scoring.length;
  return {
    score,
    maxScore,
    normalized: maxScore > 0 ? Math.max(0, Math.min(100, Math.round((score / maxScore) * 100))) : 0,
    matched,
    unknown,
    coverage: total === 0 ? 1 : (total - unknown.length) / total,
  };
}
