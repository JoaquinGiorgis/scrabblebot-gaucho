// Rival "de mercado": puja como los bots reales del lobby. Para cada letra
// toma una muestra de las pujas reales observadas (pagado = 2da puja, top =
// 1ra) y la escala con un factor aleatorio; juega palabras con una política
// razonable. Calibrado contra data/history.jsonl (ver `calibrate`).

import * as fs from "node:fs";
import { DEFAULT_PARAMS, type Params } from "../core/policy.js";
import { idx } from "../core/rules.js";
import { policyAgent, type Agent, type Rng } from "./engine.js";

export const PHASES = 5;

export interface MarketData {
  pools: number[][]; // por letra: pujas observadas (pagado y top)
  phasePools: number[][][]; // [letra][fase]: pujas observadas (pagado y top)
  paidMedian: number[][]; // [letra][fase]: mediana del precio pagado
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
  const phasePools: number[][][] = Array.from({ length: 26 }, () => Array.from({ length: PHASES }, () => []));
  const phasePaid: number[][][] = Array.from({ length: 26 }, () => Array.from({ length: PHASES }, () => []));
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-600);
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.participants.filter((p: { sim?: boolean }) => !p.sim).length < 4) continue;
    winners.push(Math.max(...r.participants.map((p: { score: number }) => p.score)));
    const n = r.auctions.length;
    r.auctions.forEach((a: { top: number | null; paid: number; letter: string }, k: number) => {
      if (a.top === null) return;
      const ph = Math.min(PHASES - 1, Math.floor((k * PHASES) / n));
      phasePools[idx(a.letter)]![ph]!.push(a.paid, a.top);
      phasePaid[idx(a.letter)]![ph]!.push(a.paid);
    });
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
    phasePools,
    paidMedian: phasePaid.map((ps) => ps.map(med)),
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

export function phaseOf(round: number, totalAuctions = 68): number {
  return Math.min(PHASES - 1, Math.floor(((round - 1) * PHASES) / totalAuctions));
}

// Rival híbrido: elige letras por necesidad (política) pero nunca puja por
// debajo de una muestra del mercado real para esa letra y fase de la partida.
export function hybridAgent(md: MarketData, p: Params, name = "Hybrid", lo = 0.55): Agent {
  const base = policyAgent(p, name);
  return {
    ...base,
    bid(seat, m, letter, r: Rng) {
      const own = base.bid(seat, m, letter, r);
      if (m.auctionsLeft <= 0) return 0;
      const pool = md.phasePools[letter]![phaseOf(m.round)]!;
      const sample = pool.length ? pool[Math.floor(r() * pool.length)]! : 0;
      const mk = Math.floor(sample * (lo + (1 - lo) * r()));
      return Math.max(0, Math.min(Math.max(own, mk), seat.balance));
    },
  };
}
