import { parentPort } from "node:worker_threads";
import { loadDict } from "../core/dict.js";
import type { PolicyImpl } from "../sim/engine.js";
import { evaluate, type EvalJob } from "./evaluate.js";

loadDict();
const impls = new Map<string, PolicyImpl>();
parentPort!.on("message", async (msg: { id: number; job: EvalJob }) => {
  let impl: PolicyImpl | undefined;
  if (msg.job.candModule) {
    if (!impls.has(msg.job.candModule)) impls.set(msg.job.candModule, await import(msg.job.candModule));
    impl = impls.get(msg.job.candModule);
  }
  parentPort!.postMessage({ id: msg.id, out: evaluate(msg.job, impl) });
});
