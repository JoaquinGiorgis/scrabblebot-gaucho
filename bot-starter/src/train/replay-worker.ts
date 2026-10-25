import { parentPort } from "node:worker_threads";
import { loadDict } from "../core/dict.js";
import type { Params } from "../core/policy.js";
import { loadReplays, replayEval } from "./replay.js";

const d = loadDict();
let games: ReturnType<typeof loadReplays> | null = null;
parentPort!.on("message", (m: { id: number; p: Params; from: number; to: number; train: number; test: number }) => {
  // Las últimas train+test partidas reales, de la más vieja a la más nueva.
  games ??= loadReplays().slice(-(m.train + m.test));
  parentPort!.postMessage({ id: m.id, out: replayEval(d, m.p, games.slice(m.from, m.to)) });
});
