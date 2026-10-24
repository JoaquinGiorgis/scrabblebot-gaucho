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
  horizonW: number; // 0 = apagado (campeón)
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
};

// Rangos para el optimizador: [min, max, entero?]
export const BOUNDS: Record<keyof Params, [number, number, boolean]> = {
  pBase: [0.2, 0.95, false],
  aHalf: [0.1, 6, false],
  maxMissing: [1, 5, true],
  minLen: [2, 7, true],
  alpha: [0, 3, false],
  beta: [0, 3, false],
  gamma: [-2, 4, false],
  pace: [0, 1.5, false],
  shade: [0.3, 1, false],
  holdKappa: [0.5, 1.6, false],
  minPlayReward: [0, 40, false],
  flushAt: [1, 6, true],
  lowCash: [0, 30, false],
  floorMult: [0, 1.5, false],
  letterTarget: [8, 20, false],
  slack: [0, 5, false],
  horizonW: [0, 2, false],
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

export function decideBid(d: Dict, p: Params, v: View, letter: number): number {
  // La ficha de la última subasta llega cuando la partida ya terminó: vale 0.
  if (v.auctionsLeft <= 0) return 0;
  const o = opts(p, v);
  const before = potential(d, v.rack, o);
  const r2 = new Int32Array(v.rack);
  r2[letter]!++;
  const after = potential(d, r2, o);
  const delta = Math.max(0, after - before);
  const spend = v.balance / Math.max(1, v.auctionsLeft);
  let bid = p.alpha * delta + p.beta * VALUE[letter]! + p.gamma + p.pace * spend;
  // Atrasados en letras: no dejar pasar letras útiles por debajo del mercado.
  if (p.floorMult > 0 && v.market && v.won !== undefined && v.round !== undefined) {
    const total = v.round + v.auctionsLeft;
    const behind = v.won < (p.letterTarget * v.round) / total - p.slack;
    let size = 0;
    for (let i = 0; i < 26; i++) size += v.rack[i]!;
    if (behind && (delta > 0 || size < 8)) {
      const mk = v.market[letter]?.[phaseOf(v.round, total)] ?? 0;
      bid = Math.max(bid, p.floorMult * mk + 1);
    }
  }
  if (v.firstPrice) bid *= p.shade;
  bid = Math.floor(bid);
  return Math.max(0, Math.min(bid, v.balance));
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
