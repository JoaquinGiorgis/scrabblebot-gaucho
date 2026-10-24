import { DEFAULT_PARAMS } from "../core/policy.js";
import { playMatch, policyAgent, simAgent, starterAgent, type Agent } from "./engine.js";
const N = Number(process.env.N ?? 40);
function run(label: string, make: () => Agent[], fp = false) {
  const t = Date.now();
  let place = 0, wins = 0, score = 0;
  const others: number[] = [];
  for (let s = 0; s < N; s++) {
    const r = playMatch(make(), 1000 + s, fp);
    place += r.places[0]!; if (r.places[0] === 0) wins++; score += r.scores[0]!;
    others.push(...r.scores.slice(1));
  }
  const avgO = others.reduce((a, b) => a + b, 0) / others.length;
  console.log(`${label.padEnd(28)} place=${(place / N + 1).toFixed(2)} win=${(100 * wins / N).toFixed(0)}% score=${(score / N).toFixed(0)} oppAvg=${avgO.toFixed(0)} ms/match=${((Date.now() - t) / N).toFixed(0)}`);
}
const sims = () => [simAgent("Cheapskate"), simAgent("ValueBidder"), simAgent("Aggressive"), simAgent("ValueBidder"), simAgent("Aggressive")];
run("starter vs 5 sims", () => [starterAgent(), ...sims()]);
run("policy vs 5 sims", () => [policyAgent(DEFAULT_PARAMS), ...sims()]);
run("policy vs 5 starters", () => [policyAgent(DEFAULT_PARAMS), ...Array.from({ length: 5 }, () => starterAgent())]);
run("policy FP vs 5 sims", () => [policyAgent(DEFAULT_PARAMS), ...sims()], true);
