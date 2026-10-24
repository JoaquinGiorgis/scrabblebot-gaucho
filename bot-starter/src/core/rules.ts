// Reglas del juego, copiadas 1:1 de spacetimedb/src/letters.ts y game.ts.
// Si el servidor cambia, este archivo es lo único que hay que tocar.

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const VALUE: number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

// Distribución estándar sin blancos: 98 fichas.
export const BAG: number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

export const STARTING_BALANCE = 100;
export const STARTING_RACK = 5;
export const DEFAULT_PLAYERS = 6;

export function idx(c: string): number {
  return c.charCodeAt(0) - 65;
}

// totalReward = base * num / den, división entera (igual que el servidor).
export function reward(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function wordReward(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += VALUE[word.charCodeAt(i) - 65]!;
  return reward(base, word.length);
}

export type Rack = Int32Array; // 26 contadores

export function emptyRack(): Rack {
  return new Int32Array(26);
}

export function rackFromMap(m: Map<string, number>): Rack {
  const r = emptyRack();
  for (const [c, n] of m) if (c.length === 1) r[idx(c)]! += n;
  return r;
}

export function rackSize(r: Rack): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += r[i]!;
  return n;
}

export function rackToString(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += LETTERS[i]!.repeat(r[i]!);
  return s;
}
