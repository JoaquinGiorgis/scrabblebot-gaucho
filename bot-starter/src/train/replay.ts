// Arena de repetición: mete una política como 7.º postor en partidas reales.
// Las letras salen en el orden real y el rival es el campo real: para ganar
// una subasta hay que superar la puja máxima real (archivada al final), y en
// Vickrey se paga esa puja. Si le sacamos una letra a un rival, pierde la
// primera palabra que después jugó con esa letra (aproximación: no la
// reemplaza por otra). Los rivales no cambian sus pujas por nosotros, y nuestro
// atril inicial sale de las 30 fichas que nunca se subastaron. La política ve
// los atriles públicos de los rivales (ganadas - jugadas), para el bloqueo.
//
//   npx tsx src/train/replay.ts [params.json ...]   -> lugar medio entre 7 en las últimas N partidas
import * as fs from "node:fs";
import { loadDict, type Dict } from "../core/dict.js";
import { chooseWords, decideBid, DEFAULT_PARAMS, type Params } from "../core/policy.js";
import { marketPrices } from "../core/prices.js";
import { BAG, idx, STARTING_BALANCE, STARTING_RACK, wordReward } from "../core/rules.js";
import { rng, type PolicyImpl } from "../sim/engine.js";

// Fracción de la palabra perdida que se le descuenta al rival. Calibrada: con
// 0.3 el campeón da lugar 2.97 y 23% de victorias; Lionel real, 2.92 y 24%.
export const STEAL = Number(process.env.STEAL ?? 0.3);

export interface Replay {
  matchId: string;
  letters: Int8Array;
  tops: Int16Array; // puja a superar (0 = nadie pujó)
  realScores: number[];
  leftover: Int32Array; // fichas nunca subastadas (los atriles iniciales)
  winners: Int8Array; // asiento del ganador real (-1 = nadie)
  words: { p: number; at: number; word: string; reward: number }[]; // at = subastas cerradas antes de jugarla
}

export function loadReplays(file = "data/scout.jsonl", type = "Vickrey"): Replay[] {
  const out: Replay[] = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    const m = JSON.parse(l);
    if (m.auctionType !== type || m.participants.length !== 6) continue;
    if (m.participants.some((p: { sim?: boolean }) => p.sim)) continue;
    if (m.auctions.some((a: { winner: string | null; top: number | null }) => a.winner && a.top === null)) continue;
    const letters = Int8Array.from(m.auctions.map((a: { letter: string }) => idx(a.letter)));
    const leftover = Int32Array.from(BAG);
    for (const c of letters) leftover[c]!--;
    if (leftover.some((x) => x < 0)) continue;
    const seat = new Map<string, number>(m.participants.map((p: { botId: string }, i: number) => [p.botId, i]));
    const times: number[] = m.auctions.map((a: { t: number }) => a.t);
    out.push({
      matchId: m.matchId,
      winners: Int8Array.from(m.auctions.map((a: { winner: string | null }) => (a.winner ? seat.get(a.winner) ?? -1 : -1))),
      words: m.words.map((w: { botId: string; word: string; reward: number; t: number }) => ({
        p: seat.get(w.botId) ?? -1, at: times.filter((t) => t <= w.t).length, word: w.word, reward: w.reward,
      })),
      letters,
      tops: Int16Array.from(m.auctions.map((a: { winner: string | null; top: number | null }) => (a.winner ? a.top! : 0))),
      realScores: m.participants.map((p: { score: number }) => p.score),
      leftover,
    });
  }
  return out.sort((a, b) => Number(a.matchId) - Number(b.matchId));
}

export interface ReplayOut { place: number; win: number; score: number; margin: number; fitness: number }

export function replayOne(d: Dict, p: Params, g: Replay, seed: number, impl: PolicyImpl = { decideBid, chooseWords }) {
  const r = rng(seed);
  const pool: number[] = [];
  g.leftover.forEach((n, c) => { for (let k = 0; k < n; k++) pool.push(c); });
  const rack = new Int32Array(26), start = new Int32Array(26);
  for (let k = 0; k < STARTING_RACK && pool.length; k++) {
    const c = pool.splice(Math.floor(r() * pool.length), 1)[0]!;
    rack[c]!++; start[c]!++;
  }
  const auctioned = new Int32Array(26);
  let balance = STARTING_BALANCE, score = 0, won = 0;
  const n = g.letters.length;
  const market = marketPrices();
  const adj = g.realScores.slice();
  const pubs = g.realScores.map(() => new Int32Array(26));
  const claimed = new Set<number>();
  let wi = 0;
  const words = g.words;
  const play = (w: string) => {
    const need = new Int32Array(26);
    for (const c of w) need[c.charCodeAt(0) - 65]!++;
    for (let i = 0; i < 26; i++) if (need[i]! > rack[i]!) return;
    for (let i = 0; i < 26; i++) rack[i]! -= need[i]!;
    const rw = wordReward(w);
    balance += rw; score += rw;
  };
  for (let k = 0; k < n; k++) {
    const letter = g.letters[k]!;
    auctioned[letter]!++;
    // Palabras de los rivales jugadas antes de esta subasta.
    for (; wi < words.length && words[wi]!.at <= k; wi++) {
      const w = words[wi]!;
      if (w.p < 0) continue;
      for (const c of w.word) { const i = c.charCodeAt(0) - 65; pubs[w.p]![i] = Math.max(0, pubs[w.p]![i]! - 1); }
    }
    const unseen = new Int32Array(26);
    for (let i = 0; i < 26; i++) unseen[i] = Math.max(0, BAG[i]! - auctioned[i]! - start[i]!);
    const view = { rack, balance, unseen, auctionsLeft: n - k - 1, firstPrice: false, won, round: k + 1, market, opp: pubs };
    for (const w of impl.chooseWords(d, p, view)) play(w);
    view.balance = balance;
    const bid = Math.min(balance, impl.decideBid(d, p, view, letter));
    const top = g.tops[k]!;
    // Empate con la máxima real: se sortea entre los dos.
    if (bid > 0 && (bid > top || (bid === top && r() < 0.5))) {
      balance -= Math.max(1, top);
      rack[letter]!++;
      won++;
      // El ganador real pierde la primera palabra que después armó con esa letra.
      const w0 = g.winners[k]!;
      if (w0 >= 0) {
        const L = String.fromCharCode(65 + letter);
        const j = words.findIndex((w, j) => j >= 0 && w.p === w0 && w.at > k && !claimed.has(j) && w.word.includes(L));
        if (j >= 0) { claimed.add(j); adj[w0]! -= Math.round(STEAL * words[j]!.reward); }
      }
    } else if (g.winners[k]! >= 0) pubs[g.winners[k]!]![letter]!++;
  }
  const place = adj.filter((s) => s > score).length + 1;
  return { place, score, margin: score - Math.max(...adj) };
}

export function replayEval(d: Dict, p: Params, games: Replay[], reps = 1, impl?: PolicyImpl): ReplayOut {
  let place = 0, win = 0, score = 0, margin = 0, n = 0;
  for (const g of games)
    for (let k = 0; k < reps; k++) {
      const o = replayOne(d, p, g, Number(g.matchId) * 13 + k, impl);
      place += o.place; win += o.place === 1 ? 1 : 0; score += o.score; margin += o.margin; n++;
    }
  const out = { place: place / n, win: win / n, score: score / n, margin: margin / n, fitness: 0 };
  out.fitness = -out.place + 0.5 * out.win + 0.002 * out.margin;
  return out;
}

if (process.argv[1]?.endsWith("replay.ts")) {
  const N = Number(process.env.N ?? 800);
  const games = loadReplays().slice(-N);
  const d = loadDict();
  const files = process.argv.slice(2);
  const sets: [string, Params][] = files.length
    ? files.map((f) => [f, { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(f, "utf8")) }])
    : [["params/vickrey.json", { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync("params/vickrey.json", "utf8")) }], ["DEFAULT", DEFAULT_PARAMS]];
  console.log(`${games.length} partidas reales (6 bots reales, Vickrey), lugar entre 7`);
  for (const [name, p] of sets) {
    const t = Date.now();
    const o = replayEval(d, p, games, Number(process.env.REPS ?? 1));
    console.log(`${name}: lugar ${o.place.toFixed(2)}  win ${(o.win * 100).toFixed(1)}%  score ${o.score.toFixed(1)}  margen ${o.margin.toFixed(1)}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
}
