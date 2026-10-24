// Rival "de mercado": puja como los bots reales del lobby. Para cada letra
// toma una muestra de las pujas reales observadas (pagado = 2da puja, top =
// 1ra) y la escala con un factor aleatorio; juega palabras con una política
// razonable. Calibrado contra data/history.jsonl (ver `calibrate`).

import * as fs from "node:fs";
import { DEFAULT_PARAMS, type Params } from "../core/policy.js";
import { idx } from "../core/rules.js";
import { policyAgent, type Agent, type Rng } from "./engine.js";

export interface MarketData {
  pools: number[][]; // por letra: pujas observadas (pagado y top)
  realTop: number[]; // mediana real del top por letra
  realPaid: number[];
  winnerMedian: number;
}

let CACHED: MarketData | null | undefined;
export function loadMarket(file = process.env.HISTORY ?? "data/history.jsonl"): MarketData | null {
  if (CACHED !== undefined) return CACHED;
  if (!fs.existsSync(file)) return (CACHED = null);
  const pools: number[][] = Array.from({ length: 26 }, () => []);
  const tops: number[][] = Array.from({ length: 26 }, () => []);
  const paids: number[][] = Array.from({ length: 26 }, () => []);
  const winners: number[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-600);
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.participants.filter((p: { sim?: boolean }) => !p.sim).length < 4) continue;
    winners.push(Math.max(...r.participants.map((p: { score: number }) => p.score)));
    for (const a of r.auctions) {
      if (a.top === null) continue;
      const i = idx(a.letter);
      pools[i]!.push(a.paid, a.top);
      tops[i]!.push(a.top);
      paids[i]!.push(a.paid);
    }
  }
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : 0);
  winners.sort((a, b) => a - b);
  return (CACHED = {
    pools,
    realTop: tops.map(med),
    realPaid: paids.map(med),
    winnerMedian: winners[winners.length >> 1] ?? 0,
  });
}

// Parámetros de juego de palabras de los rivales: guardan para 5-7 letras.
export const RIVAL_WORDS: Params = { ...DEFAULT_PARAMS, minPlayReward: 18, holdKappa: 1.0, flushAt: 2 };

export function marketAgent(md: MarketData, scale: number, spread: number, name = "Market"): Agent {
  const base = policyAgent(RIVAL_WORDS, name);
  return {
    ...base,
    bid(seat, m, letter, r: Rng) {
      if (m.auctionsLeft <= 0) return 0;
      const pool = md.pools[letter]!;
      if (pool.length === 0) return 0;
      const sample = pool[Math.floor(r() * pool.length)]!;
      const b = Math.floor(sample * scale * (1 - spread * r()));
      return Math.max(0, Math.min(b, seat.balance));
    },
  };
}

export const MARKET_SCALE = Number(process.env.MARKET_SCALE ?? 1.0);
export const MARKET_SPREAD = Number(process.env.MARKET_SPREAD ?? 0.45);
