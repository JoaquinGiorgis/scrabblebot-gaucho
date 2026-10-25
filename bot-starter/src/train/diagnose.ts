// Radiografía de la política en la arena: en qué fase pierde subastas, por
// cuánto, y cómo evoluciona el saldo. Para encontrar dónde se queda la plata.
//   N=150 npx tsx src/train/diagnose.ts params/vickrey.json
import * as fs from "node:fs";
import { loadDict } from "../core/dict.js";
import { chooseWords, decideBid, DEFAULT_PARAMS, type Params } from "../core/policy.js";
import { marketPrices, marketTop } from "../core/prices.js";
import { BAG, STARTING_BALANCE, STARTING_RACK, wordReward } from "../core/rules.js";
import { rng } from "../sim/engine.js";
import { loadReplays } from "./replay.js";

const N = Number(process.env.N ?? 150);
const d = loadDict();
const p: Params = { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(process.argv[2] ?? "params/vickrey.json", "utf8")) };
const games = loadReplays().slice(-N);
const market = marketPrices(), mtop = marketTop();

const PH = 5;
const lost = Array.from({ length: PH }, () => ({ n: 0, close: 0, zero: 0, gapSum: 0 }));
const won = Array.from({ length: PH }, () => ({ n: 0, paid: 0 }));
const balAt = Array.from({ length: PH + 1 }, () => 0);
let wordsBefore = 0, wordsFlush = 0, rewBefore = 0, rewFlush = 0, idleTiles = 0;

for (const g of games) {
  const r = rng(Number(g.matchId) * 13);
  const pool: number[] = [];
  g.leftover.forEach((n, c) => { for (let k = 0; k < n; k++) pool.push(c); });
  const rack = new Int32Array(26), start = new Int32Array(26);
  for (let k = 0; k < STARTING_RACK && pool.length; k++) {
    const c = pool.splice(Math.floor(r() * pool.length), 1)[0]!;
    rack[c]!++; start[c]!++;
  }
  const auctioned = new Int32Array(26);
  let balance = STARTING_BALANCE, w = 0;
  const n = g.letters.length;
  for (let k = 0; k < n; k++) {
    const letter = g.letters[k]!;
    auctioned[letter]!++;
    const ph = Math.min(PH - 1, Math.floor((k * PH) / n));
    if (k % Math.ceil(n / PH) === 0) balAt[ph]! += balance;
    const unseen = new Int32Array(26);
    for (let i = 0; i < 26; i++) unseen[i] = Math.max(0, BAG[i]! - auctioned[i]! - start[i]!);
    const view = { rack, balance, unseen, auctionsLeft: n - k - 1, firstPrice: false, won: w, round: k + 1, market, marketTop: mtop };
    for (const word of chooseWords(d, p, view)) {
      const need = new Int32Array(26);
      for (const c of word) need[c.charCodeAt(0) - 65]!++;
      if ([...need].some((x, i) => x > rack[i]!)) continue;
      for (let i = 0; i < 26; i++) rack[i]! -= need[i]!;
      const rw = wordReward(word);
      balance += rw;
      if (n - k - 1 <= p.flushAt) { wordsFlush++; rewFlush += rw; } else { wordsBefore++; rewBefore += rw; }
    }
    view.balance = balance;
    const bid = Math.min(balance, decideBid(d, p, view, letter));
    const top = g.tops[k]!;
    if (bid > 0 && (bid > top || (bid === top && r() < 0.5))) {
      balance -= Math.max(1, top); rack[letter]!++; w++;
      won[ph]!.n++; won[ph]!.paid += Math.max(1, top);
    } else if (top > 0) {
      lost[ph]!.n++;
      if (bid === 0) lost[ph]!.zero++;
      else { lost[ph]!.gapSum += top - bid; if (top - bid <= 3) lost[ph]!.close++; }
    }
  }
  balAt[PH]! += balance;
  idleTiles += rack.reduce((s, x) => s + x, 0);
}
const G = games.length;
console.log(`${G} partidas. Saldo medio al inicio de cada fase y al final: ${balAt.map((b) => (b / G).toFixed(0)).join(" -> ")}`);
console.log(`fichas sin usar al final: ${(idleTiles / G).toFixed(1)}  palabras antes del vaciado: ${(wordsBefore / G).toFixed(2)} (${(rewBefore / G).toFixed(0)} pts)  en el vaciado: ${(wordsFlush / G).toFixed(2)} (${(rewFlush / G).toFixed(0)} pts)`);
console.log(`fase | ganadas (pagado medio) | perdidas: sin pujar / por <=3 / brecha media`);
for (let ph = 0; ph < PH; ph++) {
  const L = lost[ph]!, W = won[ph]!;
  const bidLost = L.n - L.zero;
  console.log(`  ${ph}  | ${(W.n / G).toFixed(1)} (${(W.paid / Math.max(1, W.n)).toFixed(1)})  | ${(L.zero / G).toFixed(1)} / ${(L.close / G).toFixed(1)} / ${(L.gapSum / Math.max(1, bidLost)).toFixed(1)}`);
}
