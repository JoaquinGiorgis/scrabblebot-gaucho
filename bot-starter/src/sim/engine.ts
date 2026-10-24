// Simulador fiel a spacetimedb/src/game.ts (closeAuction, simulateBids,
// simulateWordPlay, playWord). Sin red ni tiempos: cada subasta es
// "jugar palabras -> pujar -> cerrar".

import { type Dict, loadDict } from "../core/dict.js";
import { decideBid, chooseWords, type Params } from "../core/policy.js";
import { marketPrices } from "../core/prices.js";
import {
  BAG,
  BAG_SIZE,
  STARTING_BALANCE,
  STARTING_RACK,
  VALUE,
  wordReward,
} from "../core/rules.js";

// PRNG determinista (mulberry32) para comparar candidatos con las mismas semillas.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
const randInt = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export interface Seat {
  won: number;
  rack: Int32Array;
  balance: number;
  score: number;
  start: Int32Array;
}

export interface MatchInfo {
  firstPrice: boolean;
  auctioned: Int32Array; // letras ya sacadas a subasta (incluida la actual)
  auctionsLeft: number;
  round: number;
  players: number;
}

export interface Agent {
  name: string;
  isSim: boolean; // los sims juegan dentro del servidor, solo al ganar
  bid(seat: Seat, m: MatchInfo, letter: number, r: Rng): number;
  words(seat: Seat, m: MatchInfo): string[];
  onWin?(seat: Seat, m: MatchInfo): string | undefined; // sims
}

// ---------- longest-first (lo que usan sims y el starter) ----------
let LONGEST: number[] | undefined;
function longestOrder(d: Dict): number[] {
  if (LONGEST) return LONGEST;
  const ix = Array.from({ length: d.n }, (_, i) => i);
  ix.sort((a, b) => d.len[b]! - d.len[a]! || (d.words[a]! < d.words[b]! ? -1 : 1));
  LONGEST = ix;
  return ix;
}
function longestPlayable(d: Dict, r: Int32Array, minLen: number): string | undefined {
  let total = 0;
  for (let i = 0; i < 26; i++) total += r[i]!;
  for (const k of longestOrder(d)) {
    const L = d.len[k]!;
    if (L < minLen) break;
    if (L > total) continue;
    let ok = true;
    const o = k * 26;
    for (let i = 0; i < 26; i++)
      if (d.counts[o + i]! > r[i]!) {
        ok = false;
        break;
      }
    if (ok) return d.words[k];
  }
  return undefined;
}

// ---------- Oponentes ----------
type SimKind = "Cheapskate" | "ValueBidder" | "Aggressive";
export function simAgent(kind: SimKind, d = loadDict()): Agent {
  return {
    name: kind,
    isSim: true,
    bid(seat, _m, letter, r) {
      const v = VALUE[letter]!;
      const vowel = [0, 4, 8, 14, 20].includes(letter);
      const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (vowel ? 4 : 2);
      const jitter = randInt(r, -2, 2);
      return Math.max(Math.min(Math.max(base + jitter, 1), seat.balance), 0);
    },
    words: () => [],
    onWin: (seat) => longestPlayable(d, seat.rack, 3),
  };
}

// El bot del starter kit: lo que va a correr mucha gente sin tocar.
export function starterAgent(d = loadDict()): Agent {
  return {
    name: "Starter",
    isSim: false,
    bid(seat, _m, letter) {
      const v = VALUE[letter]!;
      const want = seat.rack[letter]! === 0 ? v + 2 : Math.max(1, v);
      return Math.min(want, Math.max(0, seat.balance));
    },
    words(seat) {
      const out: string[] = [];
      const r = new Int32Array(seat.rack);
      for (;;) {
        const w = longestPlayable(d, r, 2);
        if (!w) break;
        out.push(w);
        for (const c of w) r[c.charCodeAt(0) - 65]!--;
      }
      return out;
    },
  };
}

export function unseenFor(seat: Seat, m: MatchInfo): Int32Array {
  const u = new Int32Array(26);
  for (let i = 0; i < 26; i++) u[i] = Math.max(0, BAG[i]! - m.auctioned[i]! - seat.start[i]!);
  return u;
}

export interface PolicyImpl {
  decideBid: typeof decideBid;
  chooseWords: typeof chooseWords;
}

export function policyAgent(p: Params, name = "Policy", d = loadDict(), impl: PolicyImpl = { decideBid, chooseWords }): Agent {
  const view = (seat: Seat, m: MatchInfo) => ({
    rack: seat.rack,
    balance: seat.balance,
    unseen: unseenFor(seat, m),
    auctionsLeft: m.auctionsLeft,
    firstPrice: m.firstPrice,
    won: seat.won,
    round: m.round,
    market: marketPrices(),
  });
  return {
    name,
    isSim: false,
    bid: (seat, m, letter) => impl.decideBid(d, p, view(seat, m), letter),
    words: (seat, m) => impl.chooseWords(d, p, view(seat, m)),
  };
}

// ---------- Partida ----------
export interface MatchResult {
  scores: number[];
  places: number[]; // 0 = primero; empates comparten lugar
}

function playWord(seat: Seat, w: string): boolean {
  const need = new Int32Array(26);
  for (const c of w) need[c.charCodeAt(0) - 65]!++;
  for (let i = 0; i < 26; i++) if (need[i]! > seat.rack[i]!) return false;
  for (let i = 0; i < 26; i++) seat.rack[i]! -= need[i]!;
  const rw = wordReward(w);
  seat.balance += rw;
  seat.score += rw;
  return true;
}

export function playMatch(
  agents: Agent[],
  seed: number,
  firstPrice = false,
  valid?: (w: string) => boolean,
): MatchResult {
  const r = rng(seed);
  const bag = Int32Array.from(BAG);
  let bagTotal = BAG_SIZE;
  const draw = (): number => {
    let i = randInt(r, 0, bagTotal - 1);
    for (let c = 0; c < 26; c++) {
      if (i < bag[c]!) {
        bag[c]!--;
        bagTotal--;
        return c;
      }
      i -= bag[c]!;
    }
    throw new Error("bag");
  };
  const seats: Seat[] = agents.map(() => ({
    won: 0,
    rack: new Int32Array(26),
    balance: STARTING_BALANCE,
    score: 0,
    start: new Int32Array(26),
  }));
  for (const s of seats)
    for (let n = 0; n < STARTING_RACK; n++) {
      const c = draw();
      s.rack[c]!++;
      s.start[c]!++;
    }
  const m: MatchInfo = {
    firstPrice,
    auctioned: new Int32Array(26),
    auctionsLeft: 0,
    round: 0,
    players: agents.length,
  };
  while (bagTotal > 0) {
    const letter = draw();
    m.auctioned[letter]!++;
    m.auctionsLeft = bagTotal;
    m.round++;
    // Jugadas de palabras mientras la subasta está abierta.
    agents.forEach((a, i) => {
      if (a.isSim) return;
      for (const w of a.words(seats[i]!, m)) if (!valid || valid(w)) playWord(seats[i]!, w);
    });
    // Pujas (sims primero, como en el servidor; el orden no importa: se sortea).
    const bids: { i: number; amt: number }[] = [];
    agents.forEach((a, i) => {
      const amt = Math.floor(a.bid(seats[i]!, m, letter, r));
      if (amt > 0 && amt <= seats[i]!.balance) bids.push({ i, amt });
    });
    for (let k = bids.length - 1; k >= 1; k--) {
      const j = randInt(r, 0, k);
      [bids[k], bids[j]] = [bids[j]!, bids[k]!];
    }
    bids.sort((a, b) => b.amt - a.amt); // estable
    const [first, second] = bids;
    if (first) {
      const paid = firstPrice ? first.amt : second ? second.amt : Math.min(1, first.amt);
      const s = seats[first.i]!;
      if (s.balance >= paid) {
        s.balance -= paid;
        s.rack[letter]!++;
        s.won++;
        const a = agents[first.i]!;
        if (a.isSim && a.onWin) {
          const w = a.onWin(s, m);
          if (w) playWord(s, w);
        }
      }
    }
  }
  const scores = seats.map((s) => s.score);
  const places = scores.map((sc) => scores.filter((o) => o > sc).length);
  return { scores, places };
}
