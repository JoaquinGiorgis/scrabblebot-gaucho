// Precio mediano por letra y fase de la partida (5 quintiles), sacado del
// historial público por `npm run learn`. Dos tablas: lo que se pagó
// (params/market-paid.json) y la puja máxima, que es lo que hay que superar
// (params/market-top.json). Viven en params/ para viajar con la imagen.
import * as fs from "node:fs";
import * as path from "node:path";

export const PHASES = 5;
const cache = new Map<string, { mtime: number; table: number[][] }>();

function load(...candidates: string[]): number[][] | null {
  for (const rel of candidates) {
    const file = path.join(process.cwd(), rel);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const c = cache.get(file);
      if (c && c.mtime === mtime) return c.table;
      const table = JSON.parse(fs.readFileSync(file, "utf8"));
      cache.set(file, { mtime, table });
      return table;
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

export function marketPrices(): number[][] | null {
  return load("params/market-paid.json", "data/market-prices.json");
}

export function marketTop(): number[][] | null {
  return load("params/market-top.json");
}

export function phaseOf(round: number, total: number): number {
  return Math.min(PHASES - 1, Math.floor(((round - 1) * PHASES) / Math.max(1, total)));
}
