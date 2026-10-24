// Asesor LLM (Grok o Claude), en el loop lento. Lee el reporte de partidas
// reales, el historial de entrenamiento y la política, y propone puntos de
// partida para el optimizador. No toca el bot en vivo: lo que propone entra
// como candidato a evolve.ts y solo llega a producción si gana la prueba a ciegas.
//
//   XAI_API_KEY=...        (Grok, modelo en GROK_MODEL, default grok-4)
//   ANTHROPIC_API_KEY=...  (Claude, modelo en CLAUDE_MODEL)

import * as fs from "node:fs";
import { BOUNDS } from "../core/policy.js";

const read = (f: string, max = 12000) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").slice(-max) : "(vacío)");

const prompt = `Sos el analista de estrategia de un bot de ScrabbleBot (subastas de letras, 1s cada una, score = palabras).
Reglas: valor Scrabble por letra; multiplicador por largo 1x(<=3) 1.5x(4) 2x(5) 2.5x(6) 3x(7+); saldo inicial 100; la plata solo sirve para pujar; la partida termina cuando se vacía la bolsa; el ranking premia el puesto.

POLÍTICA ACTUAL (TypeScript):
${read("src/core/policy.ts", 8000)}

PARÁMETROS CAMPEONES:
vickrey: ${read("params/vickrey.json", 2000)}
firstprice: ${read("params/firstprice.json", 2000)}

REPORTE DE PARTIDAS REALES:
${read("data/report.md", 6000)}

ÚLTIMOS ENTRENAMIENTOS (vickrey / firstprice):
${read("data/train-vickrey.jsonl", 3000)}
${read("data/train-firstprice.jsonl", 3000)}

Respondé SOLO un JSON con esta forma:
{"vickrey": {<param>: number, ...}, "firstprice": {...}, "notes": "diagnóstico breve y qué cambiarías en el código de la política"}
Rangos válidos: ${JSON.stringify(BOUNDS)}`;

async function ask(): Promise<string | null> {
  if (process.env.XAI_API_KEY) {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.XAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.GROK_MODEL ?? "grok-4", messages: [{ role: "user", content: prompt }] }),
    });
    const j = (await r.json()) as { choices?: { message: { content: string } }[] };
    return j.choices?.[0]?.message.content ?? null;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
    });
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    return j.content?.find((c) => c.type === "text")?.text ?? null;
  }
  return null;
}

const text = await ask();
if (!text) {
  console.log("[advisor] sin XAI_API_KEY ni ANTHROPIC_API_KEY: salteo");
  process.exit(0);
}
const m = text.match(/\{[\s\S]*\}/);
if (!m) {
  console.warn("[advisor] respuesta sin JSON:", text.slice(0, 300));
  process.exit(0);
}
const out = JSON.parse(m[0]) as { vickrey?: object; firstprice?: object; notes?: string };
for (const t of ["vickrey", "firstprice"] as const)
  if (out[t]) fs.writeFileSync(`params/suggested-${t}.json`, JSON.stringify(out[t], null, 2));
fs.appendFileSync("data/advisor-notes.md", `\n## ${new Date().toISOString()}\n${out.notes ?? ""}\n`);
console.log("[advisor]", out.notes);
