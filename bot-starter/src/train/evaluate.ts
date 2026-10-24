// Evaluación de un set de parámetros sobre escenarios de mesa mixtos.

import { type Params } from "../core/policy.js";
import { playMatch, policyAgent, rng, simAgent, type Agent, type PolicyImpl } from "../sim/engine.js";
import { hybridAgent, loadMarket, marketAgent, MARKET_SCALE } from "../sim/market.js";
import { DEFAULT_PARAMS } from "../core/policy.js";

export interface EvalJob {
  cand: Params;
  league: Params[]; // campeones previos (incluye el actual)
  seeds: number[];
  firstPrice: boolean;
  candModule?: string; // ruta a una variante de policy.ts (asesor LLM)
}

export interface EvalOut {
  place: number; // lugar medio, 1 = primero
  win: number;
  margin: number; // nuestro score - mejor rival
  fitness: number;
}

const SIM_KINDS = ["Cheapskate", "ValueBidder", "Aggressive", "ValueBidder", "Aggressive", "Cheapskate"] as const;

// Rival = un campeón de la liga con ruido en cómo puja (diversidad de estilos).
function jittered(p: Params, seed: number, k: number): Params {
  const r = rng(seed * 31 + k * 977);
  const f = () => 0.75 + 0.5 * r();
  return { ...p, alpha: p.alpha * f(), beta: p.beta * f(), gamma: p.gamma * f(), pace: p.pace * f(), minPlayReward: p.minPlayReward * f() };
}

// Escenario según la semilla. El lobby real es 6 bots reales cuyos precios
// reproduce bien el self-play (ver sim/calibrate.ts), así que pesa más.
export function table(seed: number, cand: Params, league: Params[], impl?: PolicyImpl): Agent[] {
  const me = policyAgent(cand, "cand", undefined, impl);
  const md = loadMarket();
  const lg = league.length ? league : [DEFAULT_PARAMS];
  const pick = (k: number) => lg[(seed * 7919 + k * 104729) % lg.length]!;
  const kind = seed % 8;
  const others: Agent[] = [];
  for (let k = 0; k < 5; k++) {
    if (kind === 7) others.push(simAgent(SIM_KINDS[(seed + k) % 6]!));
    else if (md && (kind === 5 || (kind === 6 && k < 2))) others.push(marketAgent(md, MARKET_SCALE, 0.3, `M${k}`));
    // Rivales híbridos: eligen por necesidad pero pujan al menos como el mercado real.
    else if (md && kind <= 3) others.push(hybridAgent(md, jittered(pick(k), seed, k), `H${k}`, 0.4));
    else others.push(policyAgent(jittered(pick(k), seed, k), `L${k}`));
  }
  return [me, ...others];
}

export function evaluate(job: EvalJob, impl?: PolicyImpl): EvalOut {
  let place = 0, win = 0, margin = 0;
  for (const s of job.seeds) {
    const r = playMatch(table(s, job.cand, job.league, impl), s, job.firstPrice);
    place += r.places[0]! + 1;
    if (r.places[0] === 0) win++;
    margin += r.scores[0]! - Math.max(...r.scores.slice(1));
  }
  const n = job.seeds.length;
  const out = { place: place / n, win: win / n, margin: margin / n, fitness: 0 };
  // El ranking (OpenSkill) y el torneo (puntos suizos) premian el lugar.
  out.fitness = -out.place + 0.5 * out.win + 0.002 * out.margin;
  return out;
}
