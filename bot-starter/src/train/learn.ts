// Aprende de las partidas reales (data/matches.jsonl):
//  - perfila a cada rival real (cuánto puja por letra) -> data/opponents.json,
//    que el simulador usa como oponentes "empíricos";
//  - escribe data/report.md con nuestro rendimiento, para humanos y para el LLM.

import * as fs from "node:fs";
import { idx, VALUE } from "../core/rules.js";

interface Rec {
  matchId: string;
  me: string;
  auctionType?: string;
  participants: { botId: string; name?: string; sim?: boolean; score: number }[];
  auctions: { letter: string; winner: string | null; paid: number; top: number | null }[];
  words: { botId: string; word: string; reward: number }[];
}

const file = "data/matches.jsonl";
const recs: Rec[] = fs.existsSync(file)
  ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

// ---------- perfiles de rivales ----------
// Del lado de las pujas solo vemos la del ganador (top, revelada al final) y
// el precio pagado. Ajustamos bid(letra) = media bayesiana con prior valor+2.
const PRIOR_W = 3;
const byBot = new Map<string, { name: string; sum: number[]; n: number[]; resid: number[] }>();
for (const r of recs) {
  const real = new Map(r.participants.filter((p) => !p.sim && p.botId !== r.me).map((p) => [p.botId, p.name ?? p.botId]));
  for (const a of r.auctions) {
    if (!a.winner || !real.has(a.winner) || a.top === null) continue;
    let b = byBot.get(a.winner);
    if (!b) byBot.set(a.winner, (b = { name: real.get(a.winner)!, sum: Array(26).fill(0), n: Array(26).fill(0), resid: [] }));
    const i = idx(a.letter);
    b.sum[i] += a.top;
    b.n[i]++;
    b.resid.push(a.top - (VALUE[i]! + 2));
  }
}
const profiles = [...byBot.values()]
  .filter((b) => b.n.reduce((s, x) => s + x, 0) >= 10)
  .map((b) => {
    const mult = VALUE.map((v, i) => (b.sum[i]! + PRIOR_W * (v + 2)) / (b.n[i]! + PRIOR_W));
    const mean = b.resid.reduce((s, x) => s + x, 0) / b.resid.length;
    const sd = Math.sqrt(b.resid.reduce((s, x) => s + (x - mean) ** 2, 0) / b.resid.length);
    return { name: b.name, mult: mult.map((x) => Math.round(x * 10) / 10), add: 0, noise: Math.round(sd * 10) / 10, samples: b.n.reduce((s, x) => s + x, 0) };
  });
fs.mkdirSync("data", { recursive: true });
if (profiles.length) fs.writeFileSync("data/opponents.json", JSON.stringify(profiles, null, 2));

// ---------- reporte ----------
const rows = recs.map((r) => {
  const sorted = [...r.participants].sort((a, b) => b.score - a.score);
  const mine = r.participants.find((p) => p.botId === r.me);
  const place = sorted.filter((p) => p.score > (mine?.score ?? 0)).length + 1;
  const best = sorted.find((p) => p.botId !== r.me);
  const realRivals = r.participants.filter((p) => !p.sim && p.botId !== r.me).length;
  const myWords = r.words.filter((w) => w.botId === r.me);
  const spent = r.auctions.filter((a) => a.winner === r.me).reduce((s, a) => s + a.paid, 0);
  return { id: r.matchId, type: r.auctionType, place, n: sorted.length, my: mine?.score ?? 0, best: best?.score ?? 0, bestName: best?.name, realRivals, words: myWords.map((w) => w.word), spent };
});
const last = rows.slice(-30);
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const lines = [
  `# Reporte ScrabbleBot (${new Date().toISOString()})`,
  ``,
  `Partidas registradas: ${rows.length}. Últimas ${last.length}: lugar medio ${avg(last.map((r) => r.place)).toFixed(2)}, victorias ${last.filter((r) => r.place === 1).length}, score medio ${avg(last.map((r) => r.my)).toFixed(0)}.`,
  `Partidas con rivales reales: ${rows.filter((r) => r.realRivals > 0).length} (lugar medio ${avg(rows.filter((r) => r.realRivals > 0).map((r) => r.place)).toFixed(2)}).`,
  ``,
  `## Rivales reales perfilados`,
  ...profiles.map((p) => `- ${p.name}: ${p.samples} pujas ganadoras vistas, ruido ±${p.noise}. Puja media E=${p.mult[4]} S=${p.mult[18]} Q=${p.mult[16]} Z=${p.mult[25]}`),
  ``,
  `## Peores partidas recientes`,
  ...[...last].sort((a, b) => b.place - a.place || a.my - a.best - (b.my - b.best)).slice(0, 8).map((r) =>
    `- m${r.id} (${r.type}) puesto ${r.place}/${r.n}: nosotros ${r.my} vs ${r.bestName} ${r.best}; gastado ${r.spent}; palabras ${r.words.join(", ") || "ninguna"}`),
];
fs.writeFileSync("data/report.md", lines.join("\n") + "\n");
console.log(lines.join("\n"));

// Tabla de precios de mercado por letra y fase para la política (piso de puja).
{
  const hist = "data/history.jsonl";
  if (fs.existsSync(hist)) {
    const paid: number[][][] = Array.from({ length: 26 }, () => Array.from({ length: 5 }, () => []));
    for (const l of fs.readFileSync(hist, "utf8").split("\n").filter(Boolean).slice(-600)) {
      const r = JSON.parse(l);
      const n = r.auctions.length;
      r.auctions.forEach((a: { paid: number; letter: string; winner: string | null }, k: number) => {
        if (a.winner) paid[idx(a.letter)]![Math.min(4, Math.floor((k * 5) / n))]!.push(a.paid);
      });
    }
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : 0);
    fs.writeFileSync("data/market-prices.json", JSON.stringify(paid.map((ps) => ps.map(med))));
  }
}
