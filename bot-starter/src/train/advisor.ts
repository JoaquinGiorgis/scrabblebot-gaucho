// Asesor LLM (Claude), en el loop lento. Lee la política, los datos reales y
// los intentos anteriores, y propone una variante de código + parámetros.
// La variante tiene que compilar y ganarle al campeón en un duelo sobre las
// mismas mesas simuladas; si no, se descarta. Nunca toca el bot en vivo directo.
//
//   ANTHROPIC_API_KEY=... npx tsx src/train/advisor.ts
//   ADVISOR_SEEDS=240  ADVISOR_MARGIN=0.03  POLICY_STORE=/data (Railway)

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_PARAMS, type Params } from "../core/policy.js";
import { Pool } from "./pool.js";

const ROOT = process.cwd();
const POLICY = path.join(ROOT, "src/core/policy.ts");
const CANDIDATE = path.join(ROOT, "src/core/policy.candidate.ts");
const LOG = "data/advisor-log.jsonl";
const SEEDS = Number(process.env.ADVISOR_SEEDS ?? 240);
const MARGIN = Number(process.env.ADVISOR_MARGIN ?? 0.03);

const read = (f: string, max = 20000) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").slice(-max) : "(vacío)");
const readJson = <T>(f: string, d: T): T => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

// Cómo le va a nuestro bot frente a los mejores, desde el historial público.
function rivalTable(): string {
  const f = "data/history.jsonl";
  if (!fs.existsSync(f)) return "(sin historial)";
  const agg = new Map<string, { name: string; score: number[]; won: number[]; paid: number[]; len: number[] }>();
  for (const l of fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-400)) {
    const r = JSON.parse(l);
    for (const p of r.participants) {
      if (p.sim) continue;
      let a = agg.get(p.botId);
      if (!a) agg.set(p.botId, (a = { name: p.name, score: [], won: [], paid: [], len: [] }));
      const won = r.auctions.filter((x: { winner: string }) => x.winner === p.botId);
      a.score.push(p.score);
      a.won.push(won.length);
      a.paid.push(won.reduce((s: number, x: { paid: number }) => s + x.paid, 0));
      for (const w of r.words) if (w.botId === p.botId) a.len.push(w.word.length);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return [...agg.values()]
    .filter((a) => a.score.length >= 10)
    .sort((a, b) => mean(b.score) - mean(a.score))
    .slice(0, 15)
    .map((a) => `${a.name}: partidas=${a.score.length} score=${mean(a.score).toFixed(0)} letras=${mean(a.won).toFixed(1)} gasto=${mean(a.paid).toFixed(0)} largo_palabra=${mean(a.len).toFixed(1)}`)
    .join("\n");
}

function previousAttempts(): string {
  if (!fs.existsSync(LOG)) return "(ninguno)";
  return fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-8)
    .map((l) => {
      const r = JSON.parse(l);
      return `- ${r.at}: ${r.hypothesis} -> ${r.result}${r.cand ? ` (cand place=${r.cand.place?.toFixed(2)} vs champ ${r.champ?.place?.toFixed(2)})` : ""}`;
    })
    .join("\n");
}

const SYSTEM = `Sos el investigador de estrategia de un bot que compite en ScrabbleBot (SpacetimeDB).

Reglas exactas del juego:
- Cada ronda sale una letra de una bolsa de 98 (distribución Scrabble sin blancos) y se subasta 1 segundo, sobre cerrado, Vickrey: gana la puja más alta y paga la segunda.
- Saldo inicial 100. Cada bot arranca con 5 fichas ocultas. Hay 6 bots por mesa, ~68 subastas por partida.
- Se puede jugar cualquier palabra del diccionario en cualquier momento con las fichas propias. Recompensa = suma de valores Scrabble x multiplicador por largo: 1x (<=3), 1.5x (4), 2x (5), 2.5x (6), 3x (7+). La recompensa suma al saldo y al score.
- La partida termina al cerrar la última subasta; la ficha de esa última subasta no se puede usar. La plata sobrante no vale nada. El ranking premia el puesto.
- Los rivales reales pagan ~10-12 por vocal y 25-35 por J/Q/X/Z.

Tu trabajo: proponer UNA mejora concreta y verificable a src/core/policy.ts. La variante se compila con tsc y juega un duelo de ${SEEDS} partidas simuladas contra el campeón; solo entra si gana. Las ideas ya probadas que fallaron no se repiten.

Contrato del archivo (si no se cumple, la variante se descarta):
- Mantener exports: interface Params, DEFAULT_PARAMS, BOUNDS (Record<keyof Params, [min, max, entero]>), interface View, decideBid(d, p, v, letter): number, chooseWords(d, p, v): string[].
- Solo puede importar de "./dict.js" y "./rules.js" (exports disponibles: ver código de dict.ts). Nada de I/O, red ni aleatoriedad.
- Cada llamada debe tardar pocos milisegundos (corre en vivo con subastas de 1 s).
- Si agregás parámetros, agregalos a Params, DEFAULT_PARAMS y BOUNDS, y dales valor en params_json.

Devolvé el archivo completo en policy_ts (o "" si solo cambiás parámetros), y en params_json un JSON con los parámetros completos de la variante.`;

const SCHEMA = {
  type: "object",
  properties: {
    diagnosis: { type: "string", description: "Qué está fallando, con datos" },
    hypothesis: { type: "string", description: "La mejora propuesta en una oración" },
    policy_ts: { type: "string", description: "Archivo policy.ts completo, o vacío" },
    params_json: { type: "string", description: "JSON con todos los Params de la variante" },
  },
  required: ["diagnosis", "hypothesis", "policy_ts", "params_json"],
  additionalProperties: false,
};

function logAttempt(rec: object) {
  fs.mkdirSync("data", { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[advisor] sin ANTHROPIC_API_KEY: salteo");
    return;
  }
  const champion: Params = { ...DEFAULT_PARAMS, ...readJson<Partial<Params>>("params/vickrey.json", {}) };
  const league: Params[] = readJson<Params[]>("params/league-vickrey.json", [champion]);

  const user = `POLÍTICA ACTUAL (src/core/policy.ts):
\`\`\`ts
${read(POLICY)}
\`\`\`

dict.ts (helpers disponibles):
\`\`\`ts
${read("src/core/dict.ts")}
\`\`\`

PARÁMETROS CAMPEONES: ${JSON.stringify(champion)}

NUESTRO BOT vs LOS MEJORES (últimas ~400 partidas públicas; nuestro bot es "Lionel"):
${rivalTable()}

REPORTE DE NUESTRAS PARTIDAS REALES:
${read("data/report.md", 6000)}

INTENTOS ANTERIORES DEL ASESOR:
${previousAttempts()}

ÚLTIMOS ENTRENAMIENTOS NUMÉRICOS:
${read("data/train-vickrey.jsonl", 2500)}`;

  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();
  console.log(`[advisor] tokens in=${msg.usage.input_tokens} out=${msg.usage.output_tokens} stop=${msg.stop_reason}`);
  if (msg.stop_reason !== "end_turn") {
    logAttempt({ hypothesis: "(sin respuesta)", result: `stop_reason=${msg.stop_reason}` });
    return;
  }
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const out = JSON.parse(text) as { diagnosis: string; hypothesis: string; policy_ts: string; params_json: string };
  console.log(`[advisor] diagnóstico: ${out.diagnosis}\n[advisor] hipótesis: ${out.hypothesis}`);
  fs.appendFileSync("data/advisor-notes.md", `\n## ${new Date().toISOString()}\n${out.diagnosis}\n\n**Hipótesis:** ${out.hypothesis}\n`);

  let candParams: Params;
  try {
    candParams = { ...DEFAULT_PARAMS, ...champion, ...JSON.parse(out.params_json) };
  } catch {
    logAttempt({ hypothesis: out.hypothesis, result: "params_json inválido" });
    return;
  }

  // Variante de código: escribir, compilar, validar el contrato.
  const code = out.policy_ts.trim() ? out.policy_ts : fs.readFileSync(POLICY, "utf8");
  fs.writeFileSync(CANDIDATE, code);
  try {
    try {
      execFileSync("npx", ["tsc", "--noEmit", "-p", "."], { stdio: "pipe" });
    } catch (e) {
      const err = String((e as { stdout?: Buffer }).stdout ?? e).slice(0, 1500);
      console.log(`[advisor] no compila:\n${err}`);
      logAttempt({ hypothesis: out.hypothesis, result: `no compila: ${err.slice(0, 300)}` });
      return;
    }
    const mod = await import(pathToFileURL(CANDIDATE).href);
    for (const k of ["decideBid", "chooseWords", "DEFAULT_PARAMS", "BOUNDS"])
      if (!(k in mod)) {
        logAttempt({ hypothesis: out.hypothesis, result: `falta export ${k}` });
        return;
      }

    // Duelo sobre las mismas mesas.
    const base = Math.floor(Math.random() * 1e9);
    const seeds = Array.from({ length: SEEDS }, (_, i) => base + i);
    const pool = new Pool();
    const [champ, cand] = await Promise.all([
      pool.score(champion, league, seeds),
      pool.score(candParams, league, seeds, pathToFileURL(CANDIDATE).href),
    ]);
    await pool.close();
    const accepted = cand.fitness > champ.fitness + MARGIN;
    console.log(
      `[advisor] duelo: campeón place=${champ.place.toFixed(2)} win=${(champ.win * 100).toFixed(0)}% | variante place=${cand.place.toFixed(2)} win=${(cand.win * 100).toFixed(0)}% -> ${accepted ? "ACEPTADA" : "descartada"}`,
    );
    logAttempt({ hypothesis: out.hypothesis, result: accepted ? "ACEPTADA" : "descartada", champ, cand, codeChanged: !!out.policy_ts.trim() });

    if (accepted) {
      if (out.policy_ts.trim()) {
        fs.copyFileSync(POLICY, path.join("data", `policy.prev.${Date.now()}.ts`));
        fs.writeFileSync(POLICY, code);
        // En Railway el código vive en la imagen; lo guardamos en el volumen.
        if (process.env.POLICY_STORE) fs.copyFileSync(POLICY, path.join(process.env.POLICY_STORE, "policy.ts"));
      }
      fs.writeFileSync("params/vickrey.json", JSON.stringify(candParams, null, 2));
      fs.writeFileSync("params/league-vickrey.json", JSON.stringify([candParams, ...league].slice(0, 8), null, 2));
    }
  } finally {
    if (fs.existsSync(CANDIDATE)) fs.renameSync(CANDIDATE, path.join("data", "advisor-last-candidate.ts.txt"));
  }
}

main().catch((e) => {
  console.error("[advisor] error:", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
  if (fs.existsSync(CANDIDATE)) fs.renameSync(CANDIDATE, path.join("data", "advisor-last-candidate.ts.txt"));
});
