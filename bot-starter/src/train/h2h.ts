// Duelo entre dos sets de parámetros sobre las mismas mesas (liga común).
//   npx tsx src/train/h2h.ts a.json b.json [seeds]
import * as fs from "node:fs";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { DEFAULT_PARAMS, type Params } from "../core/policy.js";
import type { EvalOut } from "./evaluate.js";

const [fa, fb, n = "210"] = process.argv.slice(2);
const load = (f: string): Params => ({ ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(f!, "utf8")) });
const A = load(fa!), B = load(fb!);
const league = [A, B, ...JSON.parse(fs.readFileSync("params/league-vickrey.json", "utf8"))];
const seeds = Array.from({ length: Number(n) }, (_, i) => 77_000_000 + i);
const W = os.cpus().length - 1;
const ws = Array.from({ length: W }, () => new Worker(new URL("./worker-shim.mjs", import.meta.url)));
let id = 0;
const run = (cand: Params, s: number[]) =>
  new Promise<EvalOut>((res) => {
    const w = ws[id++ % W]!;
    const my = id;
    const h = (m: { id: number; out: EvalOut }) => { if (m.id === my) { w.off("message", h); res(m.out); } };
    w.on("message", h);
    w.postMessage({ id: my, job: { cand, league, seeds: s, firstPrice: false } });
  });
async function score(p: Params) {
  const chunks: number[][] = [];
  for (let i = 0; i < seeds.length; i += 15) chunks.push(seeds.slice(i, i + 15));
  const outs = await Promise.all(chunks.map((c) => run(p, c)));
  const tot = (f: (o: EvalOut) => number) => outs.reduce((s, o, i) => s + f(o) * chunks[i]!.length, 0) / seeds.length;
  return { place: tot((o) => o.place), win: tot((o) => o.win), margin: tot((o) => o.margin) };
}
const [ra, rb] = await Promise.all([score(A), score(B)]);
console.log(`${fa}: place=${ra.place.toFixed(2)} win=${(ra.win * 100).toFixed(0)}% margin=${ra.margin.toFixed(1)}`);
console.log(`${fb}: place=${rb.place.toFixed(2)} win=${(rb.win * 100).toFixed(0)}% margin=${rb.margin.toFixed(1)}`);
process.exit(0);
