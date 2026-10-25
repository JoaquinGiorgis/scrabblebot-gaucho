// CEM sobre Params con la arena de repetición como fitness: entrena contra las
// pujas reales del campo (partidas viejas) y valida a ciegas en las más nuevas.
// No toca params/vickrey.json: el ganador queda en params/replay-vickrey.json.
//   GENS=12 POP=24 GAMES=160 TEST=400 npx tsx src/train/replay-evolve.ts
import * as fs from "node:fs";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { BOUNDS, DEFAULT_PARAMS, type Params } from "../core/policy.js";
import type { ReplayOut } from "./replay.js";

const GENS = Number(process.env.GENS ?? 12);
const POP = Number(process.env.POP ?? 24);
const GAMES = Number(process.env.GAMES ?? 160);
const TEST = Number(process.env.TEST ?? 400);
const TRAIN = Number(process.env.TRAIN ?? 1500);
const ELITE = Math.max(2, Math.round(POP / 4));
const KEYS = Object.keys(BOUNDS) as (keyof Params)[];
const OUT = "params/replay-vickrey.json";

const encode = (p: Params) => KEYS.map((k) => (p[k] - BOUNDS[k][0]) / (BOUNDS[k][1] - BOUNDS[k][0]));
function decode(x: number[]): Params {
  const p = { ...DEFAULT_PARAMS };
  KEYS.forEach((k, i) => {
    const [lo, hi, int] = BOUNDS[k];
    let v = lo + Math.min(1, Math.max(0, x[i]!)) * (hi - lo);
    if (int) v = Math.round(v);
    p[k] = Math.round(v * 1000) / 1000;
  });
  return p;
}
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

const N_WORKERS = Number(process.env.WORKERS ?? Math.max(1, os.cpus().length - 1));
const waiting = new Map<number, (o: ReplayOut) => void>();
let nextId = 0;
const workers = Array.from({ length: N_WORKERS }, () => {
  const w = new Worker(new URL("./replay-worker-shim.mjs", import.meta.url));
  w.on("message", (m: { id: number; out: ReplayOut }) => { waiting.get(m.id)!(m.out); waiting.delete(m.id); });
  return w;
});
const run = (p: Params, from: number, to: number) => new Promise<ReplayOut>((res) => {
  const id = nextId++;
  waiting.set(id, res);
  workers[id % N_WORKERS]!.postMessage({ id, p, from, to, train: TRAIN, test: TEST });
});
// Índices: [0, TRAIN) entrenamiento (más viejas), [TRAIN, TRAIN+TEST) prueba (más nuevas).
async function score(p: Params, from: number, to: number): Promise<ReplayOut> {
  const step = Math.ceil((to - from) / N_WORKERS);
  const parts: [number, number][] = [];
  for (let a = from; a < to; a += step) parts.push([a, Math.min(to, a + step)]);
  const outs = await Promise.all(parts.map(([a, b]) => run(p, a, b)));
  const tot = to - from;
  const avg = (f: (o: ReplayOut) => number) => outs.reduce((s, o, i) => s + f(o) * (parts[i]![1] - parts[i]![0]), 0) / tot;
  return { place: avg((o) => o.place), win: avg((o) => o.win), score: avg((o) => o.score), margin: avg((o) => o.margin), fitness: avg((o) => o.fitness) };
}
const fmt = (o: ReplayOut) => `lugar ${o.place.toFixed(2)} win ${(o.win * 100).toFixed(1)}% score ${o.score.toFixed(1)}`;

async function main() {
  const champion: Params = { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync("params/vickrey.json", "utf8")) };
  // INIT: punto de partida distinto del campeón (p. ej. una variante que ya ganó en la arena).
  let mean = encode(process.env.INIT ? { ...champion, ...JSON.parse(fs.readFileSync(process.env.INIT, "utf8")) } : champion);
  let sd = KEYS.map(() => 0.12);
  let best: { p: Params; f: number } | null = null;
  console.log(`[replay-evolve] workers=${N_WORKERS} gens=${GENS} pop=${POP} games/gen=${GAMES} train=${TRAIN} test=${TEST}`);
  for (let g = 0; g < GENS; g++) {
    const from = Math.floor(Math.random() * (TRAIN - GAMES));
    const cands = [mean, ...Array.from({ length: POP - 1 }, () => mean.map((m, i) => m + sd[i]! * gauss()))];
    const t = Date.now();
    const scored = [];
    for (const x of cands) scored.push({ x, p: decode(x), o: await score(decode(x), from, from + GAMES) });
    scored.sort((a, b) => b.o.fitness - a.o.fitness);
    const elite = scored.slice(0, ELITE);
    mean = KEYS.map((_, i) => elite.reduce((s, e) => s + e.x[i]!, 0) / ELITE);
    sd = KEYS.map((_, i) => Math.max(0.02, 0.7 * Math.sqrt(elite.reduce((s, e) => s + (e.x[i]! - mean[i]!) ** 2, 0) / ELITE) + 0.3 * sd[i]!));
    if (!best || elite[0]!.o.fitness > best.f) best = { p: elite[0]!.p, f: elite[0]!.o.fitness };
    console.log(`gen ${g + 1}/${GENS} mejor ${fmt(elite[0]!.o)} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
  // Prueba a ciegas en partidas que el optimizador nunca vio.
  const finalist = decode(mean);
  const T0 = TRAIN, T1 = TRAIN + TEST;
  const c = await score(champion, T0, T1), a = await score(finalist, T0, T1), b = await score(best!.p, T0, T1);
  const ch = a.fitness >= b.fitness ? { p: finalist, o: a } : { p: best!.p, o: b };
  console.log(`prueba a ciegas (${TEST} partidas nuevas): campeón ${fmt(c)} | retador ${fmt(ch.o)}`);
  fs.writeFileSync(OUT, JSON.stringify(ch.p, null, 2));
  fs.appendFileSync("data/train-replay.jsonl", JSON.stringify({ at: new Date().toISOString(), champion: c, challenger: ch.o, params: ch.p }) + "\n");
  for (const w of workers) await w.terminate();
}
main();
