import { parentPort } from "node:worker_threads";
import { loadDict } from "../core/dict.js";
import { evaluate, type EvalJob } from "./evaluate.js";

loadDict();
parentPort!.on("message", (msg: { id: number; job: EvalJob }) => {
  parentPort!.postMessage({ id: msg.id, out: evaluate(msg.job) });
});
