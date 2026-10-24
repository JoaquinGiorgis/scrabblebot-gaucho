// Pool de workers para evaluar sets de parámetros (y variantes de código) en paralelo.
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import type { Params } from "../core/policy.js";
import type { EvalJob, EvalOut } from "./evaluate.js";

export class Pool {
  private ws: Worker[];
  private waiting = new Map<number, (o: EvalOut) => void>();
  private next = 0;

  constructor(n = Number(process.env.WORKERS ?? Math.max(1, os.cpus().length - 1))) {
    this.ws = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./worker-shim.mjs", import.meta.url));
      w.on("message", (m: { id: number; out: EvalOut }) => {
        this.waiting.get(m.id)!(m.out);
        this.waiting.delete(m.id);
      });
      return w;
    });
  }

  private run(job: EvalJob): Promise<EvalOut> {
    const id = this.next++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.ws[id % this.ws.length]!.postMessage({ id, job });
    });
  }

  // Promedio sobre todas las semillas, partidas en trozos para usar todos los núcleos.
  async score(cand: Params, league: Params[], seeds: number[], candModule?: string): Promise<EvalOut> {
    const chunks: number[][] = [];
    for (let i = 0; i < seeds.length; i += 12) chunks.push(seeds.slice(i, i + 12));
    const outs = await Promise.all(chunks.map((s) => this.run({ cand, league, seeds: s, firstPrice: false, candModule })));
    const avg = (f: (o: EvalOut) => number) => outs.reduce((t, o, i) => t + f(o) * chunks[i]!.length, 0) / seeds.length;
    return { place: avg((o) => o.place), win: avg((o) => o.win), margin: avg((o) => o.margin), fitness: avg((o) => o.fitness) };
  }

  async close() {
    for (const w of this.ws) await w.terminate();
  }
}
