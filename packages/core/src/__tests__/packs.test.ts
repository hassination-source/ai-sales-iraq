import { describe, expect, it } from "vitest";
import {
  autoPartsPack,
  definePack,
  getPack,
  missingForStage,
  PACKS,
  resolveConfig,
  scoreCompany,
  solarEnergyPack,
  toPipelineStages,
  validateQualification,
} from "../index";

describe("industry packs", () => {
  it("every registered pack is valid and has won/lost stages", () => {
    for (const p of Object.values(PACKS)) {
      expect(p.stages.some((s) => s.kind === "won")).toBe(true);
      expect(p.stages.some((s) => s.kind === "lost")).toBe(true);
    }
  });

  it("packs have different funnels without core changes", () => {
    expect(solarEnergyPack.stages.map((s) => s.key)).not.toEqual(autoPartsPack.stages.map((s) => s.key));
    expect(autoPartsPack.qualificationFields.some((f) => f.key === "estimated_load_kw")).toBe(false);
  });

  it("rejects a pack whose stage requires an undefined field", () => {
    expect(() =>
      definePack({
        ...autoPartsPack,
        id: "broken",
        stages: [
          { key: "a", label: { ar: "أ", en: "A" }, requires: ["nope"] },
          { key: "w", label: { ar: "ر", en: "W" }, kind: "won" },
          { key: "l", label: { ar: "خ", en: "L" }, kind: "lost" },
        ],
      }),
    ).toThrow(/unknown qualification field \\?"nope/);
  });

  it("rejects scoring rules on unknown fields and missing won stage", () => {
    expect(() => definePack({ ...autoPartsPack, id: "x", scoring: [{ key: "k", when: { field: "attributes.ghost", op: "present" }, points: 1, reason: { ar: "x", en: "x" } }] })).toThrow(/unknown field/);
    expect(() => definePack({ ...autoPartsPack, id: "y", stages: autoPartsPack.stages.filter((s) => s.kind !== "won") })).toThrow(/won stage/);
  });

  it("getPack checks id and version", () => {
    expect(getPack("solar-energy", 1).id).toBe("solar-energy");
    expect(() => getPack("bakery")).toThrow(/unknown industry pack/);
    expect(() => getPack("solar-energy", 9)).toThrow(/not available/);
  });

  it("produces create_tenant stage payloads", () => {
    const stages = toPipelineStages(solarEnergyPack);
    expect(stages.at(-2)).toMatchObject({ key: "won", kind: "won" });
    expect(stages[0]!.label.ar).toBe("عميل جديد");
  });
});

describe("tenant overrides", () => {
  it("can replace stages, add fields, disable rules and set territories", () => {
    const cfg = resolveConfig(solarEnergyPack, {
      territories: ["IQ-BG", "IQ-BA"],
      addQualificationFields: [{ key: "tender_number", label: { ar: "رقم المناقصة", en: "Tender no." }, type: "text" }],
      scoring: [{ key: "reachable", when: { field: "phone", op: "present" }, points: 0, reason: { ar: "x", en: "x" } }],
    });
    expect(cfg.territories).toEqual(["IQ-BG", "IQ-BA"]);
    expect(cfg.qualificationFields.some((f) => f.key === "tender_number")).toBe(true);
    expect(cfg.scoring.some((r) => r.key === "reachable")).toBe(false);
  });

  it("rejects overrides that break the pack", () => {
    expect(() => resolveConfig(solarEnergyPack, { stages: [{ key: "only", label: { ar: "x", en: "x" } }] })).toThrow();
    expect(() => resolveConfig(solarEnergyPack, { unknownKey: true })).toThrow();
  });
});

describe("qualification", () => {
  it("validates solar qualification values", () => {
    expect(validateQualification(solarEnergyPack, { project_type: "hybrid", project_location: "IQ-BG", estimated_load_kw: 120 }).success).toBe(true);
    expect(validateQualification(solarEnergyPack, { project_type: "nuclear" }).success).toBe(false);
    expect(validateQualification(solarEnergyPack, { project_location: "Baghdad" }).success).toBe(false); // must be a code
    expect(validateQualification(solarEnergyPack, { invented_field: 1 }).success).toBe(false);
  });

  it("blocks stage entry until required facts are known", () => {
    expect(missingForStage(solarEnergyPack, "proposal_sent", { estimated_load_kw: 100 })).toEqual(["system_capacity_kwp"]);
    expect(missingForStage(solarEnergyPack, "contacted", {})).toEqual([]);
    expect(() => missingForStage(solarEnergyPack, "nope", {})).toThrow();
  });
});

describe("scoring", () => {
  const cfg = resolveConfig(solarEnergyPack, { territories: ["IQ-BG"] });

  it("scores known facts and explains why", () => {
    const r = scoreCompany(cfg, {
      governorate: "IQ-BG",
      phone: "+9647701234567",
      verification_status: "unverified",
      attributes: { segment: "factory", uses_diesel_generator: true, grid_hours_per_day: 8, roof_or_land_area_m2: 2000 },
    });
    expect(r.matched.map((m) => m.key).sort()).toEqual(["diesel_generator", "high_consumption_segment", "in_territory", "limited_grid", "reachable", "space_available"]);
    expect(r.unknown).toEqual([]);
    expect(r.coverage).toBe(1);
  });

  it("never treats unknown data as a negative or a positive", () => {
    const r = scoreCompany(cfg, { attributes: { segment: "hotel" } });
    expect(r.unknown.map((u) => u.key)).toEqual(expect.arrayContaining(["diesel_generator", "limited_grid", "space_available", "in_territory"]));
    expect(r.score).toBe(25);
    expect(r.coverage).toBeLessThan(0.6);
  });

  it("in_territory is unknown when the tenant has no territories", () => {
    const r = scoreCompany(resolveConfig(solarEnergyPack), { governorate: "IQ-BA" });
    expect(r.unknown.some((u) => u.key === "in_territory")).toBe(true);
  });
});
