// Automejora: Cross-Entropy Method sobre Params, evaluado en paralelo contra
// una liga (sims + starter + campeones anteriores + rivales reales aprendidos).
// Un candidato solo reemplaza al campeón si le gana en una prueba a ciegas.
//
//   AUCTION=vickrey|firstprice GENS=10 POP=24 SEEDS=24 npm run evolve

import * as fs from "node:fs";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { BOUNDS, DEFAULT_PARAMS, type Params } from "../core/policy.js";
import type { EvalJob, EvalOut } from "./evaluate.js";

const TYPE = process.env.AUCTION === "firstprice" ? "firstprice" : "vickrey";
const FP = TYPE === "firstprice";
const GENS = Number(process.env.GENS ?? 10);
const POP = Number(process.env.POP ?? 24);
const ELITE = Math.max(2, Math.round(POP / 4));
const SEEDS = Number(process.env.SEEDS ?? 24);
const VERIFY = Number(process.env.VERIFY ?? 120);
const LEAGUE_MAX = 8;
const CHAMP = `params/${TYPE}.json`;
const LEAGUE = `params/league-${TYPE}.json`;
const LOG = `data/train-${TYPE}.jsonl`;

const KEYS = Object.keys(BOUNDS) as (keyof Params)[];
const readJson = <T>(f: string, d: T): T => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

function encode(p: Params): number[] {
  return KEYS.map((k) => {
    const [lo, hi] = BOUNDS[k];
    return (p[k] - lo) / (hi - lo);
  });
}
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
function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

// ---------- pool de workers ----------
const N_WORKERS = Number(process.env.WORKERS ?? Math.max(1, os.cpus().length - 1));
const workers: Worker[] = [];
const waiting = new Map<number, (o: EvalOut) => void>();
let nextId = 0;
for (let i = 0; i < N_WORKERS; i++) {
  const w = new Worker(new URL("./worker-shim.mjs", import.meta.url));
  w.on("message", (m: { id: number; out: EvalOut }) => {
    waiting.get(m.id)!(m.out);
    waiting.delete(m.id);
  });
  workers.push(w);
}
function run(job: EvalJob): Promise<EvalOut> {
  const id = nextId++;
  return new Promise((res) => {
    waiting.set(id, res);
    workers[id % N_WORKERS]!.postMessage({ id, job });
  });
}
// Parte las semillas en trozos para usar todos los núcleos y promedia.
async function evalSplit(cand: Params, league: Params[], seeds: number[]): Promise<EvalOut> {
  const chunk = Math.ceil(seeds.length / Math.min(N_WORKERS, seeds.length));
  const parts: Promise<EvalOut>[] = [];
  for (let i = 0; i < seeds.length; i += chunk)
    parts.push(run({ cand, league, seeds: seeds.slice(i, i + chunk), firstPrice: FP }));
  const outs = await Promise.all(parts);
  const w = outs.map((_, i) => Math.min(chunk, seeds.length - i * chunk));
  const avg = (f: (o: EvalOut) => number) => outs.reduce((s, o, i) => s + f(o) * w[i]!, 0) / seeds.length;
  return { place: avg((o) => o.place), win: avg((o) => o.win), margin: avg((o) => o.margin), fitness: avg((o) => o.fitness) };
}

async function main() {
  fs.mkdirSync("params", { recursive: true });
  fs.mkdirSync("data", { recursive: true });
  const champion: Params = { ...DEFAULT_PARAMS, ...readJson<Partial<Params>>(CHAMP, {}) };
  let league: Params[] = readJson<Params[]>(LEAGUE, []);
  if (league.length === 0) league = [champion];
  console.log(`[evolve:${TYPE}] workers=${N_WORKERS} gens=${GENS} pop=${POP} seeds=${SEEDS} league=${league.length}`);

  let mean = encode(champion);
  let sd = KEYS.map(() => 0.15);
  let bestEver: { p: Params; f: number } | null = null;
  const base = Math.floor(Math.random() * 1e9);

  for (let g = 0; g < GENS; g++) {
    const seeds = Array.from({ length: SEEDS }, (_, i) => base + g * 10007 + i);
    const cands: number[][] = [mean, ...Array.from({ length: POP - 1 }, () => mean.map((m, i) => m + sd[i]! * gauss()))];
    // La sugerencia del asesor LLM compite como un candidato más en la gen 1.
    const SUGG = `params/suggested-${TYPE}.json`;
    if (g === 0 && fs.existsSync(SUGG)) {
      cands[POP - 1] = encode({ ...champion, ...readJson<Partial<Params>>(SUGG, {}) });
      fs.renameSync(SUGG, `${SUGG}.used`);
    }
    const t = Date.now();
    const scored = await Promise.all(
      cands.map(async (x) => ({ x, p: decode(x), o: await evalSplit(decode(x), league, seeds) })),
    );
    scored.sort((a, b) => b.o.fitness - a.o.fitness);
    const elite = scored.slice(0, ELITE);
    mean = KEYS.map((_, i) => elite.reduce((s, e) => s + e.x[i]!, 0) / ELITE);
    sd = KEYS.map((_, i) => {
      const v = elite.reduce((s, e) => s + (e.x[i]! - mean[i]!) ** 2, 0) / ELITE;
      return Math.max(0.02, 0.7 * Math.sqrt(v) + 0.3 * sd[i]!);
    });
    const top = elite[0]!;
    if (!bestEver || top.o.fitness > bestEver.f) bestEver = { p: top.p, f: top.o.fitness };
    console.log(
      `gen ${g + 1}/${GENS} best place=${top.o.place.toFixed(2)} win=${(top.o.win * 100).toFixed(0)}% margin=${top.o.margin.toFixed(1)} (${((Date.now() - t) / 1000).toFixed(0)}s)`,
    );
  }

  // Prueba a ciegas: semillas nuevas, candidato vs campeón en las mismas mesas.
  const finalist = decode(mean);
  const vseeds = Array.from({ length: VERIFY }, (_, i) => base + 9_000_000 + i);
  const [a, b, c] = await Promise.all([
    evalSplit(finalist, league, vseeds),
    evalSplit(bestEver!.p, league, vseeds),
    evalSplit(champion, league, vseeds),
  ]);
  const challenger = a.fitness >= b.fitness ? { p: finalist, o: a } : { p: bestEver!.p, o: b };
  const promoted = challenger.o.fitness > c.fitness + 0.02;
  console.log(`verify: champion place=${c.place.toFixed(2)} fit=${c.fitness.toFixed(3)} | challenger place=${challenger.o.place.toFixed(2)} fit=${challenger.o.fitness.toFixed(3)} -> ${promoted ? "PROMOTED" : "kept champion"}`);
  if (promoted) {
    fs.writeFileSync(CHAMP, JSON.stringify(challenger.p, null, 2));
    league = [challenger.p, ...league].slice(0, LEAGUE_MAX);
    fs.writeFileSync(LEAGUE, JSON.stringify(league, null, 2));
  }
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), champion: c, challenger: challenger.o, promoted, params: challenger.p }) + "\n");
  for (const w of workers) await w.terminate();
}

main();
