import { z } from "zod";
import type { EffectiveConfig, FieldDef, IndustryPack } from "./pack";
import { GOVERNORATES } from "./geo";

/** Build a zod schema for a set of pack fields. Every field is optional: unknown stays unknown (absent), never defaulted. */
export function schemaFor(fields: FieldDef[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    let s: z.ZodTypeAny;
    switch (f.type) {
      case "number": {
        let n = z.number().finite();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        s = n;
        break;
      }
      case "boolean":
        s = z.boolean();
        break;
      case "enum":
        s = z.enum(f.options!.map((o) => o.value) as [string, ...string[]]);
        break;
      case "multi_enum":
        s = z.array(z.enum(f.options!.map((o) => o.value) as [string, ...string[]])).min(1);
        break;
      case "date":
        s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
        break;
      case "governorate":
        s = z.enum(GOVERNORATES.map((g) => g.code) as [string, ...string[]]);
        break;
      default:
        s = z.string().trim().min(1).max(2000);
    }
    shape[f.key] = s.optional();
  }
  return z.object(shape).strict();
}

export function validateQualification(cfg: IndustryPack, values: unknown) {
  return schemaFor(cfg.qualificationFields).safeParse(values ?? {});
}

/** Which required fields are still unknown before a deal can enter `stageKey`. Empty array = allowed. */
export function missingForStage(cfg: EffectiveConfig | IndustryPack, stageKey: string, qualification: Record<string, unknown>): string[] {
  const stage = cfg.stages.find((s) => s.key === stageKey);
  if (!stage) throw new Error(`unknown stage "${stageKey}"`);
  return stage.requires.filter((k) => qualification[k] === undefined || qualification[k] === null || qualification[k] === "");
}
