// Ingeniería inversa por comportamiento: arma un "dossier" de cada bot real a
// partir de data/scout.jsonl (cuánto puja, cuándo, qué letras, qué palabras
// juega, cuándo las juega, cuánta plata y fichas le sobran).
//   npx tsx src/train/dossier.ts   -> data/dossiers.json + data/scouting.md
import * as fs from "node:fs";
import { idx, VALUE } from "../core/rules.js";

interface M {
  matchId: string;
  auctionType: string;
  participants: { botId: string; name?: string; sim?: boolean; score: number; balance: number }[];
  auctions: { letter: string; winner: string | null; paid: number; top: number | null; t: number }[];
  words: { botId: string; word: string; reward: number; t: number }[];
}

const RECENT = Number(process.env.RECENT ?? 300); // partidas más recientes por bot = su versión actual
const MIN = Number(process.env.MIN ?? 20);
const ms: M[] = fs.readFileSync("data/scout.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
ms.sort((a, b) => Number(a.matchId) - Number(b.matchId));
const board = new Map<string, { mu: number; sigma: number }>(
  JSON.parse(fs.readFileSync("data/leaderboard.json", "utf8")).map((b: { botId: string; mu: number; sigma: number }) => [b.botId, b]),
);

const VOWELS = new Set("AEIOU");
const PREMIUM = new Set("JQXZK");
const byBot = new Map<string, M[]>();
for (const m of ms) for (const p of m.participants) if (!p.sim && p.name) (byBot.get(p.botId) ?? byBot.set(p.botId, []).get(p.botId)!).push(m);

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

const dossiers = [];
for (const [id, all] of byBot) {
  if (all.length < MIN) continue;
  const games = all.slice(-RECENT);
  const name = games[0]!.participants.find((p) => p.botId === id)!.name!;
  const place: number[] = [], score: number[] = [], win: number[] = [], left: number[] = [], spent: number[] = [];
  const won: number[] = [], wasted: number[] = [], nWords: number[] = [];
  const topByPhase: number[][] = [[], [], [], [], []], markup: number[] = [], overpay: number[] = [];
  const topVowel: number[] = [], topCons: number[] = [], topPrem: number[] = [];
  const wordLen: number[] = [], wordRew: number[] = [], wordPhase: number[] = [], immediate: number[] = [];
  const winShare = Array(26).fill(0), seen = Array(26).fill(0);
  const byType: Record<string, number[]> = {};
  const realOpp: number[] = [];
  for (const m of games) {
    const me = m.participants.find((p) => p.botId === id)!;
    const sorted = [...m.participants].sort((a, b) => b.score - a.score);
    const pl = sorted.filter((p) => p.score > me.score).length + 1;
    place.push(pl); score.push(me.score); win.push(pl === 1 ? 1 : 0); left.push(me.balance);
    (byType[m.auctionType] ??= []).push(pl);
    realOpp.push(m.participants.filter((p) => !p.sim && p.botId !== id).length);
    const n = m.auctions.length;
    let w = 0, sp = 0;
    m.auctions.forEach((a, k) => {
      seen[idx(a.letter)]++;
      if (a.winner !== id) return;
      w++; sp += a.paid; winShare[idx(a.letter)]++;
      if (a.top !== null) {
        topByPhase[Math.min(4, Math.floor((k * 5) / n))]!.push(a.top);
        markup.push(a.top - VALUE[idx(a.letter)]!);
        overpay.push(a.top - a.paid);
        (VOWELS.has(a.letter) ? topVowel : PREMIUM.has(a.letter) ? topPrem : topCons).push(a.top);
      }
    });
    won.push(w); spent.push(sp);
    const mine = m.words.filter((x) => x.botId === id);
    nWords.push(mine.length);
    const startRack = Math.round((98 - n) / m.participants.length);
    wasted.push(w + startRack - mine.reduce((s, x) => s + x.word.length, 0));
    const myWins = m.auctions.filter((a) => a.winner === id).map((a) => a.t);
    for (const x of mine) {
      wordLen.push(x.word.length); wordRew.push(x.reward);
      wordPhase.push(m.auctions.filter((a) => a.t <= x.t).length / Math.max(1, n));
      immediate.push(myWins.some((t) => x.t >= t && x.t - t < 1200) ? 1 : 0);
    }
  }
  const b = board.get(id);
  const favorites = winShare.map((c, i) => ({ l: String.fromCharCode(65 + i), r: seen[i] ? c / seen[i] / (avg(won) / 98) : 0 }))
    .filter((x) => seen[x.l.charCodeAt(0) - 65]! > 20).sort((a, b) => b.r - a.r);
  dossiers.push({
    botId: id, name, games: all.length, sampled: games.length,
    rating: b ? Math.round(1500 + 25 * (b.mu - 25)) : null, mu: b ? r2(b.mu) : null, sigma: b ? r2(b.sigma) : null,
    place: r2(avg(place)), winRate: r2(avg(win)), score: r1(avg(score)), realOpponents: r1(avg(realOpp)),
    placeByType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, `${r2(avg(v))} (${v.length})`])),
    lettersWon: r1(avg(won)), spent: r1(avg(spent)), leftover: r1(avg(left)), wastedTiles: r1(avg(wasted)),
    topBidByPhase: topByPhase.map((x) => r1(avg(x))), markupOverFace: r1(avg(markup)), topMinusPaid: r1(avg(overpay)),
    topVowel: r1(avg(topVowel)), topConsonant: r1(avg(topCons)), topPremium: r1(avg(topPrem)),
    wordsPerGame: r1(avg(nWords)), wordLen: r1(avg(wordLen)), share7plus: r2(avg(wordLen.map((l) => (l >= 7 ? 1 : 0)))),
    rewardPerWord: r1(avg(wordRew)), playPhase: r2(avg(wordPhase)), playsRightAfterWin: r2(avg(immediate)),
    lateShare: r2(avg(wordPhase.map((p) => (p > 0.8 ? 1 : 0)))),
    favoriteLetters: favorites.slice(0, 5).map((x) => `${x.l}×${r1(x.r)}`).join(" "),
    avoidedLetters: favorites.slice(-4).map((x) => `${x.l}×${r1(x.r)}`).join(" "),
  });
}
dossiers.sort((a, b) => (b.mu ?? -99) - (a.mu ?? -99));
fs.writeFileSync("data/dossiers.json", JSON.stringify(dossiers, null, 1));

// Qué rasgos separan a los que ganan: correlación de cada rasgo con el lugar medio.
const feats = ["lettersWon", "spent", "leftover", "wastedTiles", "markupOverFace", "wordsPerGame", "wordLen", "share7plus", "rewardPerWord", "playPhase", "playsRightAfterWin", "lateShare"] as const;
const solid = dossiers.filter((d) => d.sampled >= 50);
const corr = (xs: number[], ys: number[]) => {
  const mx = avg(xs), my = avg(ys);
  const c = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
  return c / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
};
const lines = [
  `# Scouting de bots (${new Date().toISOString().slice(0, 16)})`, ``,
  `${ms.length} partidas, ${dossiers.length} bots reales con ≥${MIN} partidas (rasgos sobre sus últimas ${RECENT}).`, ``,
  `## Qué separa a los que ganan (correlación con lugar medio; negativo = mejor lugar)`,
  ...feats.map((f) => [f, corr(solid.map((d) => d[f] as number), solid.map((d) => d.place))] as const)
    .sort((a, b) => a[1] - b[1]).map(([f, c]) => `- ${f}: ${r2(c)}`),
  ``, `## Top 15 por rating`, ``,
  `| bot | rating | lugar | win% | score | letras | gasto | sobra $ | fichas muertas | puja por fase | pal/partida | largo | 7+ | juega en | tras ganar |`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ...dossiers.slice(0, 15).map((d) =>
    `| ${d.name} | ${d.rating} | ${d.place} | ${Math.round(d.winRate * 100)} | ${d.score} | ${d.lettersWon} | ${d.spent} | ${d.leftover} | ${d.wastedTiles} | ${d.topBidByPhase.join("/")} | ${d.wordsPerGame} | ${d.wordLen} | ${Math.round(d.share7plus * 100)}% | ${d.playPhase} | ${Math.round(d.playsRightAfterWin * 100)}% |`),
];
fs.writeFileSync("data/scouting.md", lines.join("\n") + "\n");
console.log(lines.join("\n"));
