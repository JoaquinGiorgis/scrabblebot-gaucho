// Compara precios y scores de mesas de 6 rivales de mercado contra los reales.
//   MARKET_SCALE=1 MARKET_SPREAD=0.45 npx tsx src/sim/calibrate.ts
import { VALUE } from "../core/rules.js";
import { playMatch, type Agent, type MatchResult } from "./engine.js";
import { hybridAgent, loadMarket, marketAgent, MARKET_SCALE, MARKET_SPREAD } from "./market.js";
import * as fs from "node:fs";
import { DEFAULT_PARAMS } from "../core/policy.js";
import { policyAgent } from "./engine.js";
const RIVAL = process.env.RIVAL_PARAMS ? { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(process.env.RIVAL_PARAMS, "utf8")) } : null;

const md = loadMarket()!;
const N = Number(process.env.N ?? 40);
const tops: number[][] = Array.from({ length: 26 }, () => []);
const paids: number[][] = Array.from({ length: 26 }, () => []);
const winners: number[] = [];
for (let s = 0; s < N; s++) {
  const agents: Agent[] = Array.from({ length: 6 }, (_, k) => (process.env.HYBRID && RIVAL ? hybridAgent(md, RIVAL, `H${k}`, Number(process.env.HYBRID)) : RIVAL ? policyAgent(RIVAL, `P${k}`) : marketAgent(md, MARKET_SCALE, MARKET_SPREAD, `M${k}`)));
  // Interceptar pujas para medir top/pagado.
  const log: { letter: number; bids: number[] }[] = [];
  const wrapped = agents.map((a, i) => ({
    ...a,
    bid: (seat: Parameters<Agent["bid"]>[0], m: Parameters<Agent["bid"]>[1], letter: number, r: () => number) => {
      const b = a.bid(seat, m, letter, r);
      if (i === 0) log.push({ letter, bids: [] });
      log[log.length - 1]!.bids.push(b);
      return b;
    },
  }));
  const res: MatchResult = playMatch(wrapped, 5000 + s);
  winners.push(Math.max(...res.scores));
  for (const { letter, bids } of log) {
    const sorted = bids.filter((b) => b > 0).sort((a, b) => b - a);
    if (sorted[0] !== undefined) tops[letter]!.push(sorted[0]);
    paids[letter]!.push(sorted[1] ?? 1);
  }
}
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : 0);
winners.sort((a, b) => a - b);
console.log(`ganador sim mediana ${winners[winners.length >> 1]} (real ${md.winnerMedian})`);
let err = 0;
const row: string[] = [];
for (let i = 0; i < 26; i++) {
  if (!tops[i]!.length) continue;
  row.push(`${String.fromCharCode(65 + i)}:${med(tops[i]!)}/${med(paids[i]!)} (${md.realTop[i]}/${md.realPaid[i]})`);
  err += Math.abs(med(paids[i]!) - md.realPaid[i]!) * (VALUE[i]! <= 1 ? 3 : 1);
}
console.log(row.join("  "));
console.log(`error pagado ponderado: ${err.toFixed(0)}`);
