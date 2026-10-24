#!/usr/bin/env bash
# Supervisor del bot en vivo: si se cae o se desconecta, lo vuelve a levantar.
#   BOT_NAME=<name> [BOT_TOKEN=<token>] [TOURNAMENT_ID=<id>] ./play.sh
cd "$(dirname "$0")"
mkdir -p data
while :; do
  npx tsx src/index.ts 2>&1 | tee -a "data/live-${BOT_NAME:-bot}.log"
  unset BOT_TOKEN 2>/dev/null || true
  echo "reiniciando en 3s..."; sleep 3
done
