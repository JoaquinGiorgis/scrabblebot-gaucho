// Política parametrizada. Todo lo que el optimizador ajusta vive en `Params`.

import {
  bestPartition,
  bestWord,
  potential,
  subtract,
  type Dict,
  type PotentialOpts,
} from "./dict.js";
import { phaseOf } from "./prices.js";
import { type Rack, VALUE } from "./rules.js";

export interface Params {
  // valuación
  pBase: number;
  aHalf: number;
  maxMissing: number;
  minLen: number;
  alpha: number; // peso del delta de potencial
  beta: number; // peso del valor facial
  gamma: number; // constante
  pace: number; // peso de "gastá lo que te sobra"
  shade: number; // factor de puja en first-price (1 = sin sombreo)
  // jugar palabras
  holdKappa: number; // jugar w si reward(w)+V(resto) >= kappa*V(rack)
  minPlayReward: number; // nunca jugar palabras que paguen menos
  flushAt: number; // vaciar todo cuando quedan <= flushAt subastas
  lowCash: number; // por debajo, jugar algo para tener plata
  // piso de puja según el ritmo de compra
  floorMult: number; // 0 = apagado; si vamos atrasados, pujar >= floorMult * precio de mercado
  letterTarget: number; // letras que queremos ganar en la partida
  slack: number; // cuántas letras de atraso toleramos antes de activar el piso
  // horizonte: escala la escasez por la fracción de no-vistas que aún saldrán a subasta
  horizonW: number; // 0 = apagado
  // multiplicador del peso facial cuando la letra no mejora el potencial (1 = campeón)
  idleBeta: number;
  // final de partida y ritmo de gasto
  endN: number; // en las últimas endN subastas, valuar por el mejor vaciado final exacto (0 = apagado)
  allIn: number; // 1 = en la última ficha jugable, pujar todo si suma al vaciado final
  c0: number; // puja *= e^c0 * (saldo por subasta restante / 3)^c1
  c1: number;
  // bloqueo: pujar al menos denyW x lo que la letra le suma a la mejor palabra de un rival
  denyW: number; // 0 = apagado
  // tope por puja: fracción del saldo que se abre a medida que avanza la partida
  capBase: number; // tope al inicio (1 = sin tope); al final siempre 1
  capPow: number; // qué tan tarde se abre (más alto = más tarde)
  // final: en las últimas endRounds subastas la puja sube hasta 1+endBoost
  endBoost: number; // 0 = apagado
  endRounds: number;
  // el piso de mercado usa la puja máxima (lo que hay que superar) en vez del precio pagado
  floorTop: number; // 0/1
  // segunda palabra: valor del atril = mejor palabra + w2 x potencial del resto sin ella
  w2: number; // 0 = apagado (solo la mejor palabra)
  // piso incondicional (estilo bro): pujar >= baseFloor x precio de mercado en toda subasta
  baseFloor: number; // 0 = apagado
  baseFloorMax: number; // solo mientras el atril tenga menos de estas fichas
  // pacing contra una curva de saldo objetivo 100*(1-t)^paceExp: por encima de la
  // curva la puja sube (exp(paceK*(saldo-objetivo)/50)), por debajo baja
  paceK: number; // 0 = apagado
  paceExp: number; // 1 = lineal; los del top gastan como ~1.5 (mitad del saldo al 30%)
  // Q sin U ni I en el atril: la puja se multiplica por qW (el 27% de nuestras Q quedan sin usar)
  qW: number; // 1 = sin efecto
}

export const DEFAULT_PARAMS: Params = {
  pBase: 0.55,
  aHalf: 1.5,
  maxMissing: 3,
  minLen: 4,
  alpha: 1.0,
  beta: 1.0,
  gamma: 0.5,
  pace: 0.3,
  shade: 0.7,
  holdKappa: 1.0,
  minPlayReward: 12,
  flushAt: 2,
  lowCash: 6,
  floorMult: 0,
  letterTarget: 14,
  slack: 2,
  horizonW: 0,
  idleBeta: 1,
  endN: 0,
  allIn: 0,
  c0: 0,
  c1: 0,
  denyW: 0,
  capBase: 1,
  capPow: 2,
  endBoost: 0,
  endRounds: 10,
  floorTop: 0,
  w2: 0,
  baseFloor: 0,
  baseFloorMax: 12,
  paceK: 0,
  paceExp: 1.5,
  qW: 1,
};

// Rangos para el optimizador: [min, max, entero?]
export const BOUNDS: Record<keyof Params, [number, number, boolean]> = {
  pBase: [0.2, 0.95, false],
  aHalf: [0.1, 6, false],
  maxMissing: [1, 5, true],
  minLen: [2, 7, true],
  alpha: [0, 3, false],
  beta: [0, 3, false],
  gamma: [-2, 8, false],
  pace: [0, 1.5, false],
  shade: [0.3, 1, false],
  holdKappa: [0.5, 1.6, false],
  minPlayReward: [0, 70, false],
  flushAt: [1, 6, true],
  lowCash: [0, 30, false],
  floorMult: [0, 1.5, false],
  letterTarget: [8, 20, false],
  slack: [-4, 5, false],
  horizonW: [0, 2, false],
  idleBeta: [0, 1.5, false],
  endN: [0, 12, true],
  allIn: [0, 1, true],
  c0: [-1, 1.5, false],
  c1: [-0.8, 1.2, false],
  denyW: [0, 2, false],
  capBase: [0.1, 1, false],
  capPow: [0.5, 4, false],
  endBoost: [0, 4, false],
  endRounds: [2, 24, true],
  floorTop: [0, 1, true],
  w2: [0, 1, false],
  baseFloor: [0, 1.3, false],
  baseFloorMax: [4, 20, true],
  paceK: [0, 2, false],
  paceExp: [0.3, 3, false],
  qW: [0, 1.5, false],
};

export interface View {
  rack: Rack;
  balance: number;
  unseen: Int32Array; // fichas que todavía pueden salir: bolsa - subastadas (incl. la actual) - mi atril inicial
  auctionsLeft: number; // subastas después de la actual
  firstPrice: boolean;
  won?: number; // letras ganadas en esta partida
  round?: number; // número de subasta actual (1-based)
  market?: number[][] | null; // [letra][fase] precio pagado mediano
  marketTop?: number[][] | null; // [letra][fase] puja máxima mediana
  opp?: Int32Array[]; // atriles públicos de los rivales (ganadas - jugadas)
}

function opts(p: Params, v: View): PotentialOpts {
  // No pedimos más letras de las que quedan por subastar.
  const horizon = Math.max(0, Math.min(p.maxMissing, v.auctionsLeft));
  // Escalar u por f (fracción de no-vistas que saldrá a subasta) equivale a
  // pBase*u/(u + aHalf/f): mantenemos unseen entero y ajustamos aHalf.
  let aHalf = p.aHalf;
  if (p.horizonW > 0) {
    let U = 0;
    for (let i = 0; i < 26; i++) U += v.unseen[i]!;
    const f = U > 0 ? Math.min(1, Math.max(0.02, v.auctionsLeft / U)) : 1;
    aHalf = p.aHalf / Math.pow(f, p.horizonW);
  }
  return {
    unseen: v.unseen,
    maxMissing: horizon,
    pBase: p.pBase,
    aHalf,
    minLen: p.minLen,
  };
}

// Valor del atril: la mejor palabra alcanzable y, si w2 > 0, también lo que
// queda por armar con el resto una vez jugada la mejor palabra ya formable.
function rackValue(d: Dict, p: Params, r: Rack, o: PotentialOpts): number {
  const main = potential(d, r, o);
  if (p.w2 <= 0) return main;
  const k = bestWord(d, r, o.minLen);
  if (k < 0) return main;
  return main + p.w2 * potential(d, subtract(d, r, k), o);
}

export function decideBid(d: Dict, p: Params, v: View, letter: number): number {
  // La ficha de la última subasta llega cuando la partida ya terminó: vale 0.
  if (v.auctionsLeft <= 0) return 0;
  const o = opts(p, v);
  const before = rackValue(d, p, v.rack, o);
  const r2 = new Int32Array(v.rack);
  r2[letter]!++;
  const after = rackValue(d, p, r2, o);
  let delta = Math.max(0, after - before);
  const spend = v.balance / Math.max(1, v.auctionsLeft);
  // Final: lo que la letra suma al mejor conjunto de palabras jugable al cierre.
  if (v.auctionsLeft <= p.endN || (p.allIn >= 1 && v.auctionsLeft === 1)) {
    const dump = bestPartition(d, r2).score - bestPartition(d, v.rack).score;
    if (p.allIn >= 1 && v.auctionsLeft === 1) return dump > 0 ? v.balance : 0;
    delta = Math.max(0, dump);
  }
  // Letra ociosa (no mejora ningún objetivo): su valor facial pesa menos.
  const faceW = delta > 0 ? p.beta : p.beta * p.idleBeta;
  let bid = p.alpha * delta + faceW * VALUE[letter]! + p.gamma + p.pace * spend;
  if (p.c0 !== 0 || p.c1 !== 0) bid *= Math.exp(p.c0) * Math.pow(Math.max(0.1, spend) / 3, p.c1);
  // Q huérfana: sin U ni I casi no hay palabras con Q.
  if (letter === 16 && p.qW !== 1 && v.rack[20]! === 0 && v.rack[8]! === 0) bid *= p.qW;
  // Pacing: gastar al ritmo de los que ganan, no guardar para un final que no llega.
  if (p.paceK > 0 && v.round !== undefined) {
    const frac = (v.round - 1) / Math.max(1, v.round + v.auctionsLeft);
    const target = 100 * Math.pow(1 - frac, p.paceExp);
    bid *= Math.exp((p.paceK * (v.balance - target)) / 50);
  }
  // Final: la plata que sobre no vale nada, así que las últimas letras pagan más.
  if (p.endBoost > 0 && v.auctionsLeft <= p.endRounds) {
    bid *= 1 + (p.endBoost * (p.endRounds + 1 - v.auctionsLeft)) / (p.endRounds + 1);
  }
  // Atrasados en letras: no dejar pasar letras útiles por debajo del mercado.
  if (p.floorMult > 0 && v.market && v.won !== undefined && v.round !== undefined) {
    const total = v.round + v.auctionsLeft;
    const behind = v.won < (p.letterTarget * v.round) / total - p.slack;
    let size = 0;
    for (let i = 0; i < 26; i++) size += v.rack[i]!;
    if (behind && (delta > 0 || size < 8)) {
      const table = p.floorTop >= 1 && v.marketTop ? v.marketTop : v.market;
      const mk = table[letter]?.[phaseOf(v.round, total)] ?? 0;
      bid = Math.max(bid, p.floorMult * mk + 1);
    }
  }
  if (p.baseFloor > 0 && v.market && v.round !== undefined) {
    let size = 0;
    for (let i = 0; i < 26; i++) size += v.rack[i]!;
    if (size < p.baseFloorMax) {
      const mk = v.market[letter]?.[phaseOf(v.round, v.round + v.auctionsLeft)] ?? 0;
      bid = Math.max(bid, p.baseFloor * mk + 1);
    }
  }
  if (p.denyW > 0 && v.opp) bid = Math.max(bid, p.denyW * denyGain(d, v.opp, letter));
  if (v.firstPrice) bid *= p.shade;
  // Tope: nunca quemar medio saldo en una letra temprana (la Z a 50 en la ronda 5).
  let cap = v.balance;
  if (p.capBase < 1 && v.round !== undefined) {
    const total = v.round + v.auctionsLeft;
    const frac = 1 - v.auctionsLeft / Math.max(1, total);
    cap = v.balance * Math.min(1, p.capBase + (1 - p.capBase) * Math.pow(frac, p.capPow));
  }
  bid = Math.floor(Math.min(bid, cap));
  return Math.max(0, Math.min(bid, v.balance));
}

// Cuánto mejora la mejor palabra del rival que más gana con esta letra.
function denyGain(d: Dict, opp: Int32Array[], letter: number): number {
  let best = 0;
  for (const r of opp) {
    let n = 0;
    for (let i = 0; i < 26; i++) n += r[i]!;
    if (n < 3) continue;
    const k0 = bestWord(d, r, 2);
    const r2 = new Int32Array(r);
    r2[letter]!++;
    const k1 = bestWord(d, r2, 2);
    const g = (k1 >= 0 ? d.rew[k1]! : 0) - (k0 >= 0 ? d.rew[k0]! : 0);
    if (g > best) best = g;
  }
  return best;
}

// Palabras a jugar ahora (puede ser varias en el vaciado final).
export function chooseWords(d: Dict, p: Params, v: View): string[] {
  if (v.auctionsLeft <= p.flushAt) {
    return bestPartition(d, v.rack).words.map((k) => d.words[k]!);
  }
  const out: string[] = [];
  let rack = v.rack;
  let cash = v.balance;
  for (let guard = 0; guard < 4; guard++) {
    const k = bestWord(d, rack, 2);
    if (k < 0) break;
    const rw = d.rew[k]!;
    const needCash = cash < p.lowCash;
    if (rw < p.minPlayReward && !needCash) break;
    const o = opts(p, { ...v, rack });
    const rest = subtract(d, rack, k);
    const hold = potential(d, rack, o);
    const play = rw + potential(d, rest, o);
    if (play < p.holdKappa * hold && !needCash) break;
    out.push(d.words[k]!);
    rack = rest;
    cash += rw;
  }
  return out;
}
