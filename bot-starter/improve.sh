#!/usr/bin/env bash
# Loop de automejora. Cada ciclo: aprender de partidas reales -> (cada
# ADVISOR_EVERY ciclos) pedir sugerencias al LLM -> evolucionar ambos tipos de
# subasta. El bot en vivo recarga params/*.json solo, sin reiniciar.
#   ./improve.sh            # infinito
#   CYCLES=1 ./improve.sh   # un ciclo
set -u
cd "$(dirname "$0")"
CYCLES=${CYCLES:-0}
ADVISOR_EVERY=${ADVISOR_EVERY:-3}
i=0
while :; do
  i=$((i+1))
  echo "=== ciclo $i $(date) ==="
  FROM=${HISTORY_FROM:-3000} npx tsx src/train/history.ts 2>&1 | grep -v INFO || true
  npx tsx src/train/learn.ts | head -5
  if [ $(( (i-1) % ADVISOR_EVERY )) -eq 0 ]; then npx tsx src/train/advisor.ts || true; fi
  AUCTION=vickrey    GENS=${GENS:-8} POP=${POP:-24} SEEDS=${SEEDS:-24} npx tsx src/train/evolve.ts
  # Todo el lobby es Vickrey; first-price solo si el torneo lo usa.
  if [ "${FIRSTPRICE:-0}" = "1" ]; then
    AUCTION=firstprice GENS=${GENS:-8} POP=${POP:-24} SEEDS=${SEEDS:-24} npx tsx src/train/evolve.ts
  fi
  [ "$CYCLES" -gt 0 ] && [ "$i" -ge "$CYCLES" ] && break
done
