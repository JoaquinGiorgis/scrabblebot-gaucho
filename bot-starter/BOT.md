# Nuestro bot de ScrabbleBot

## Cómo juega
- **Valuación de letras:** para cada letra subastada calcula cuánto mejora la mejor palabra alcanzable con lo que ya tiene, contando qué letras faltan y cuántas quedan por salir. La puja es ese valor más el valor facial de la letra y un término de ritmo de gasto ("gastá lo que te sobra", porque la plata al final no vale nada). En subasta de primer precio puja un poco por debajo de ese valor.
- **Palabras:** no juega cualquier palabra. Se guarda las letras mientras le convenga apuntar a palabras de 7+ letras, que pagan 3×. Juega cuando la palabra de ahora más lo que puede armar con el resto supera lo que puede armar si espera, y cerca del final juega todo lo que tiene.
- **Cosas que sacamos del código del servidor:** la ficha de la última subasta no se puede usar (la partida termina al cerrar esa subasta), así que no puja por ella. Las fichas sin puja no vuelven a la bolsa. Los bots simulados solo juegan cuando ganan una subasta, y siempre la palabra más larga que tengan.

## Automejora (dos loops)
1. **Rápido, numérico (`./improve.sh`):** un optimizador (Cross-Entropy Method) juega miles de partidas en `src/sim/`, que copia las reglas del servidor. Juega contra una liga: los bots simulados, el bot del starter kit, sus propios campeones anteriores y perfiles de rivales reales. Un candidato solo reemplaza al campeón si le gana en una prueba a ciegas con semillas nuevas.
2. **Lento, LLM (`src/train/advisor.ts`):** Grok (`XAI_API_KEY`) o Claude (`ANTHROPIC_API_KEY`) leen `data/report.md` y el historial de entrenamiento, y proponen parámetros y cambios de código. Esas propuestas pasan por la misma prueba a ciegas, así que el LLM no puede empeorar el bot.
3. **Datos reales:** el bot en vivo guarda cada partida en `data/matches.jsonl`, incluidas las pujas máximas que se revelan al final. `npm run learn` perfila a los rivales reales y el simulador los usa como oponentes.

El bot en vivo recarga `params/*.json` cuando cambian, sin reiniciarse y sin crear una versión nueva (crear una versión nueva resetea el rating).

## Comandos
```bash
BOT_NAME=<nombre> BOT_TOKEN=<token de /team> ./play.sh   # primera vez
BOT_NAME=<nombre> ./play.sh                              # después
BOT_NAME=<nombre> TOURNAMENT_ID=<id> ./play.sh           # inscribirse al torneo
./improve.sh                                             # automejora infinita (otra terminal)
npm run bench                                            # comparación rápida en el simulador
```

## Arena de repetición (la referencia desde el 24/10)
El simulador de `src/sim/` dice que ganamos el 87% de las partidas; en vivo ganamos ~35%. No sirve para decidir. La referencia es `src/train/replay.ts`: mete la política en partidas reales contra las pujas máximas archivadas.
- `npx tsx src/train/scout.ts` baja todo el historial (`data/scout.jsonl`) y el leaderboard.
- `N=400 npx tsx src/train/replay.ts a.json b.json` compara params como 7.º postor en las 400 partidas más nuevas.
- `SELF=Lionel N=300 REPS=2 npx tsx src/train/replay.ts a.json` **arena propia**: reemplaza a Lionel en sus propias partidas contra los otros 5 reales (la puja máxima de los otros se conoce exacta: lo pagado si Lionel ganó, la puja del ganador si perdió). Es la más fiel.
- `STEAL` (0.3) descuenta al rival la palabra que perdió por la letra que le sacamos; `DRAIN` (0.3) descuenta lo que el ganador paga de más por nuestra puja perdedora (Vickrey). Calibrados para reproducir los resultados reales de Lionel.
- `SELF=Lionel DRAIN=0.3 TRAIN=190 TEST=98 GAMES=100 REPS=2 npx tsx src/train/replay-evolve.ts` optimiza en esa arena y prueba a ciegas en partidas no vistas. Escribe `params/replay-vickrey.json`; nunca toca `params/vickrey.json`.
- `npx tsx src/train/dossier.ts` perfila el comportamiento de cada bot real (`data/scouting.md`); `npx tsx src/train/diagnose.ts` muestra en qué fase perdemos subastas y dónde queda la plata.

## Lo que aprendimos del campo (24-25/10)
- Todos los bots del top, y nosotros, convertimos ~0.53 puntos por moneda gastada. El puntaje es casi la plata gastada. Bro (2.º) gasta 184 y le sobran 10; Lionel gasta 162 y le sobran 24. Esa es toda la diferencia.
- Esa plata queda en el saldo (~20) con el que llegamos a la ronda 55 y en los puntos del vaciado final, que entran cuando ya no hay nada que comprar.
- Probado y descartado en la arena: tope por puja, impulso final, piso de mercado desde la ronda 1 (estilo bro), bloqueo de letras al rival, c0 alto, c1 alto o negativo. Todos empatan o pierden contra producción. Los parámetros actuales son un óptimo robusto de esta política.
- Nijello (3.º, código público en bananatruck/scrabblebot-evo, sin licencia) ganó +6 puntos de win rate con *look-ahead* en las últimas 12 subastas: simula el resto de la partida por cada puja candidata. Es el siguiente cambio estructural con evidencia a favor.
- La latencia de decisión es ~3 ms (máximo 51 ms) contra una ventana de 1000 ms: hay tiempo de sobra para look-ahead.
