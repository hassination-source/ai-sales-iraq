import type { IndustryPack } from "../pack";
import { solarEnergyPack } from "./solar-energy";
import { autoPartsPack } from "./auto-parts";

/** Registry of available industry packs. Adding an industry = adding a file here. */
export const PACKS: Readonly<Record<string, IndustryPack>> = {
  [solarEnergyPack.id]: solarEnergyPack,
  [autoPartsPack.id]: autoPartsPack,
};

export function getPack(id: string, version?: number): IndustryPack {
  const p = PACKS[id];
  if (!p) throw new Error(`unknown industry pack "${id}"`);
  if (version !== undefined && version !== p.version) throw new Error(`pack "${id}" v${version} not available (have v${p.version})`);
  return p;
}

export { solarEnergyPack, autoPartsPack };
