// Precio pagado mediano por letra y fase de la partida (5 quintiles), sacado
// del historial público por `npm run learn` -> data/market-prices.json.
import * as fs from "node:fs";
import * as path from "node:path";

export const PHASES = 5;
let cache: { mtime: number; table: number[][] } | null = null;

export function marketPrices(file = path.join(process.cwd(), "data", "market-prices.json")): number[][] | null {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!cache || cache.mtime !== mtime) cache = { mtime, table: JSON.parse(fs.readFileSync(file, "utf8")) };
    return cache.table;
  } catch {
    return null;
  }
}

export function phaseOf(round: number, total: number): number {
  return Math.min(PHASES - 1, Math.floor(((round - 1) * PHASES) / Math.max(1, total)));
}
