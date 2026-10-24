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
