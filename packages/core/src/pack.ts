import { z } from "zod";
import { LocalizedText, LOCALES } from "./i18n";
import { OsmTagFilter } from "./discovery/osm";

/**
 * Industry pack: everything industry-specific lives here as data.
 * The core platform (DB, CRM, drafts, metrics) never branches on pack id.
 */

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, "keys are snake_case");

export const FieldDef = z
  .object({
    key: Key,
    label: LocalizedText,
    type: z.enum(["text", "number", "boolean", "enum", "multi_enum", "date", "governorate"]),
    unit: z.string().optional(),
    options: z.array(z.object({ value: Key, label: LocalizedText })).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    help: LocalizedText.optional(),
  })
  .strict()
  .refine((f) => !["enum", "multi_enum"].includes(f.type) || (f.options && f.options.length > 0), {
    message: "enum fields need options",
  });
export type FieldDef = z.infer<typeof FieldDef>;

export const StageDef = z
  .object({
    key: Key,
    label: LocalizedText,
    kind: z.enum(["open", "won", "lost"]).default("open"),
    probability: z.number().min(0).max(100).optional(),
    /** qualification fields that must be known before a deal may enter this stage */
    requires: z.array(Key).default([]),
  })
  .strict();
export type StageDef = z.infer<typeof StageDef>;

/** A scoring condition on a company attribute or a core company field. */
export const Condition = z.discriminatedUnion("op", [
  z.object({ field: z.string(), op: z.literal("eq"), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ field: z.string(), op: z.literal("in"), value: z.array(z.string()) }),
  z.object({ field: z.string(), op: z.literal("gte"), value: z.number() }),
  z.object({ field: z.string(), op: z.literal("lte"), value: z.number() }),
  z.object({ field: z.string(), op: z.literal("present") }),
  z.object({ field: z.string(), op: z.literal("in_territory") }),
]);
export type Condition = z.infer<typeof Condition>;

export const ScoringRule = z
  .object({ key: Key, when: Condition, points: z.number().int(), reason: LocalizedText })
  .strict();
export type ScoringRule = z.infer<typeof ScoringRule>;

export const Segment = z
  .object({
    key: Key,
    label: LocalizedText,
    painPoints: z.array(LocalizedText).default([]),
    /** How the agent finds this kind of business in public directories */
    discovery: z
      .object({
        /** OpenStreetMap: any matching group (all conditions in a group must hold) */
        osm: z.array(z.array(OsmTagFilter).min(1)).default([]),
        /** free-text searches for providers like Google Places */
        searchTerms: z.array(LocalizedText).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export const IndustryPack = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    name: LocalizedText,
    description: LocalizedText,
    /** Ideal-customer segments; pain points are hypotheses to verify, never facts about a prospect. */
    segments: z.array(Segment).min(1),
    companyFields: z.array(FieldDef).default([]),
    qualificationFields: z.array(FieldDef).default([]),
    stages: z.array(StageDef).min(2),
    scoring: z.array(ScoringRule).default([]),
    languages: z.array(z.enum(LOCALES)).min(1),
    channels: z.array(z.enum(["whatsapp", "email", "sms", "phone", "in_person"])).min(1),
    ai: z
      .object({
        /** Facts the AI must never state unless they come from a verified source or the knowledge base */
        neverInvent: z.array(LocalizedText).default([]),
        /** Topics that must be handed to a human */
        escalateOn: z.array(LocalizedText).default([]),
        toneGuide: LocalizedText.optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((p, ctx) => {
    const dupes = (keys: string[], path: string) => {
      const seen = new Set<string>();
      for (const k of keys) {
        if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path], message: `duplicate key "${k}"` });
        seen.add(k);
      }
    };
    dupes(p.stages.map((s) => s.key), "stages");
    dupes(p.companyFields.map((f) => f.key), "companyFields");
    dupes(p.qualificationFields.map((f) => f.key), "qualificationFields");
    dupes(p.scoring.map((r) => r.key), "scoring");
    dupes(p.segments.map((s) => s.key), "segments");

    if (!p.stages.some((s) => s.kind === "won")) ctx.addIssue({ code: "custom", path: ["stages"], message: "needs a won stage" });
    if (!p.stages.some((s) => s.kind === "lost")) ctx.addIssue({ code: "custom", path: ["stages"], message: "needs a lost stage" });

    const qKeys = new Set(p.qualificationFields.map((f) => f.key));
    for (const s of p.stages)
      for (const r of s.requires)
        if (!qKeys.has(r)) ctx.addIssue({ code: "custom", path: ["stages", s.key], message: `requires unknown qualification field "${r}"` });

    const scorable = new Set([...CORE_COMPANY_FIELDS, ...p.companyFields.map((f) => `attributes.${f.key}`)]);
    for (const r of p.scoring)
      if (!scorable.has(r.when.field))
        ctx.addIssue({ code: "custom", path: ["scoring", r.key], message: `unknown field "${r.when.field}"` });
  });
export type IndustryPack = z.infer<typeof IndustryPack>;

/** Core company columns scoring rules may reference. Pack fields are referenced as attributes.<key>. */
export const CORE_COMPANY_FIELDS = ["governorate", "city", "website", "phone", "email", "industry", "subindustry", "verification_status"] as const;

export function definePack(input: z.input<typeof IndustryPack>): IndustryPack {
  return IndustryPack.parse(input);
}

/* ------------------------------------------------------------------ */
/* Tenant overrides                                                    */
/* ------------------------------------------------------------------ */

export const TenantOverrides = z
  .object({
    /** Replace the stage list entirely (tenant's own sales process) */
    stages: z.array(StageDef).optional(),
    addQualificationFields: z.array(FieldDef).default([]),
    addCompanyFields: z.array(FieldDef).default([]),
    /** Add or replace scoring rules by key; set points 0 to disable a pack rule */
    scoring: z.array(ScoringRule).default([]),
    languages: z.array(z.enum(LOCALES)).optional(),
    channels: z.array(z.enum(["whatsapp", "email", "sms", "phone", "in_person"])).optional(),
    /** Governorate codes the tenant sells into (drives in_territory scoring and filters) */
    territories: z.array(z.string()).default([]),
    extraAiInstructions: z.string().max(4000).optional(),
  })
  .strict();
export type TenantOverrides = z.infer<typeof TenantOverrides>;

export interface EffectiveConfig extends IndustryPack {
  territories: string[];
  extraAiInstructions?: string;
}

/** Merge a pack with tenant overrides and re-validate the result as a whole. */
export function resolveConfig(pack: IndustryPack, rawOverrides: unknown = {}): EffectiveConfig {
  const o = TenantOverrides.parse(rawOverrides ?? {});
  const scoring = new Map(pack.scoring.map((r) => [r.key, r]));
  for (const r of o.scoring) scoring.set(r.key, r);

  const merged = IndustryPack.parse({
    ...pack,
    stages: o.stages ?? pack.stages,
    qualificationFields: [...pack.qualificationFields, ...o.addQualificationFields],
    companyFields: [...pack.companyFields, ...o.addCompanyFields],
    scoring: [...scoring.values()].filter((r) => r.points !== 0),
    languages: o.languages ?? pack.languages,
    channels: o.channels ?? pack.channels,
  });
  return { ...merged, territories: o.territories, extraAiInstructions: o.extraAiInstructions };
}

/** Stage payload for app.create_tenant() */
export function toPipelineStages(cfg: IndustryPack) {
  return cfg.stages.map((s) => ({ key: s.key, label: s.label, kind: s.kind, probability: s.probability ?? null }));
}
