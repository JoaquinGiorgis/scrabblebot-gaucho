// Diccionario compilado a arrays tipados, ordenado por recompensa descendente.
// Todas las búsquedas recorren en ese orden y cortan apenas la recompensa
// restante no puede superar al mejor encontrado.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Rack, reward, VALUE } from "./rules.js";

export interface Dict {
  n: number;
  words: string[];
  counts: Uint8Array; // n*26
  len: Uint8Array;
  rew: Uint16Array;
  mask: Int32Array;
}

let CACHED: Dict | undefined;

function defaultPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/core o dist/core -> ../../../spacetimedb/wordlist.txt
  return path.resolve(here, "..", "..", "..", "spacetimedb", "wordlist.txt");
}

export function loadDict(file = process.env.WORDLIST ?? defaultPath()): Dict {
  if (CACHED) return CACHED;
  const raw = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2 && /^[A-Z]+$/.test(l));
  const scored = raw.map((w) => {
    let base = 0;
    for (let i = 0; i < w.length; i++) base += VALUE[w.charCodeAt(i) - 65]!;
    return { w, r: reward(base, w.length) };
  });
  scored.sort((a, b) => b.r - a.r || a.w.length - b.w.length);
  const n = scored.length;
  const d: Dict = {
    n,
    words: new Array(n),
    counts: new Uint8Array(n * 26),
    len: new Uint8Array(n),
    rew: new Uint16Array(n),
    mask: new Int32Array(n),
  };
  for (let k = 0; k < n; k++) {
    const { w, r } = scored[k]!;
    d.words[k] = w;
    d.len[k] = w.length;
    d.rew[k] = r;
    let m = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - 65;
      d.counts[k * 26 + c]!++;
      m |= 1 << c;
    }
    d.mask[k] = m;
  }
  CACHED = d;
  return d;
}

function maskOf(r: Rack): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (r[i]! > 0) m |= 1 << i;
  return m;
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function spellable(d: Dict, k: number, r: Rack): boolean {
  const o = k * 26;
  for (let i = 0; i < 26; i++) if (d.counts[o + i]! > r[i]!) return false;
  return true;
}

export function rackTotal(r: Rack): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += r[i]!;
  return n;
}

// Índice de la palabra con mayor recompensa formable con `r`, o -1.
export function bestWord(d: Dict, r: Rack, minLen = 2): number {
  const rm = maskOf(r);
  const total = rackTotal(r);
  for (let k = 0; k < d.n; k++) {
    if ((d.mask[k]! & ~rm) !== 0) continue;
    const L = d.len[k]!;
    if (L > total || L < minLen) continue;
    if (spellable(d, k, r)) return k;
  }
  return -1;
}

// Las primeras `limit` palabras formables, por recompensa descendente.
export function spellableList(d: Dict, r: Rack, limit: number): number[] {
  const out: number[] = [];
  const rm = maskOf(r);
  const total = rackTotal(r);
  for (let k = 0; k < d.n && out.length < limit; k++) {
    if ((d.mask[k]! & ~rm) !== 0) continue;
    if (d.len[k]! > total) continue;
    if (spellable(d, k, r)) out.push(k);
  }
  return out;
}

export function subtract(d: Dict, r: Rack, k: number): Rack {
  const out = new Int32Array(r);
  const o = k * 26;
  for (let i = 0; i < 26; i++) out[i]! -= d.counts[o + i]!;
  return out;
}

// Mejor conjunto de palabras disjuntas (beam search). Para el vaciado final.
export function bestPartition(
  d: Dict,
  r: Rack,
  beam = 6,
  branch = 8,
): { words: number[]; score: number } {
  type S = { rack: Rack; words: number[]; score: number };
  let frontier: S[] = [{ rack: r, words: [], score: 0 }];
  let best: S = frontier[0]!;
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: S[] = [];
    for (const s of frontier) {
      const cands = spellableList(d, s.rack, branch);
      for (const k of cands) {
        // Orden canónico (índices no crecientes) para no repetir permutaciones.
        const last = s.words[s.words.length - 1];
        if (last !== undefined && k < last) continue;
        const ns: S = {
          rack: subtract(d, s.rack, k),
          words: [...s.words, k],
          score: s.score + d.rew[k]!,
        };
        next.push(ns);
        if (ns.score > best.score) best = ns;
      }
    }
    next.sort((a, b) => b.score - a.score);
    frontier = next.slice(0, beam);
  }
  return { words: best.words, score: best.score };
}

export interface PotentialOpts {
  unseen: Int32Array; // fichas que aún podrían salir a subasta (estimado)
  maxMissing: number; // letras faltantes máximas para considerar una palabra
  pBase: number; // prob. base de conseguir cada letra faltante
  aHalf: number; // escasez: p *= unseen/(unseen+aHalf)
  minLen: number;
}

// Valor esperado (heurístico) de la mejor palabra alcanzable desde `r`:
// max_w reward(w) * prod_{faltantes} p(c).
export function potential(d: Dict, r: Rack, o: PotentialOpts): number {
  const rm = maskOf(r);
  let best = 0;
  const pc = new Float64Array(26);
  for (let i = 0; i < 26; i++) {
    const u = o.unseen[i]!;
    pc[i] = u > 0 ? (o.pBase * u) / (u + o.aHalf) : 0;
  }
  const maxM = o.maxMissing;
  for (let k = 0; k < d.n; k++) {
    const rw = d.rew[k]!;
    if (rw <= best) break; // ordenado: nada de acá en adelante puede ganar
    const L = d.len[k]!;
    if (L < o.minLen) continue;
    const miss = d.mask[k]! & ~rm;
    if (miss !== 0 && popcount(miss) > maxM) continue;
    const off = k * 26;
    let missing = 0;
    let p = 1;
    let ok = true;
    for (let i = 0; i < 26; i++) {
      const need = d.counts[off + i]! - r[i]!;
      if (need > 0) {
        if (need > o.unseen[i]!) {
          ok = false;
          break;
        }
        missing += need;
        if (missing > maxM) {
          ok = false;
          break;
        }
        for (let t = 0; t < need; t++) p *= pc[i]!;
      }
    }
    if (!ok) continue;
    const v = rw * p;
    if (v > best) best = v;
  }
  return best;
}
