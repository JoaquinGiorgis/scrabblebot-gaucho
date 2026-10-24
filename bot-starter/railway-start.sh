#!/usr/bin/env bash
# En Railway: data/ y params/ viven en el volumen /data para sobrevivir redeploys.
set -u
cd "$(dirname "$0")"
VOL=${RAILWAY_VOLUME_MOUNT_PATH:-/data}
mkdir -p "$VOL/data" "$VOL/params"
# Sembrar el volumen con los campeones de la imagen solo la primera vez.
for f in params/*.json; do [ -e "$f" ] && { [ ! -e "$VOL/$f" ] || [ "${SEED_PARAMS:-}" = "force" ]; } && cp "$f" "$VOL/$f"; done
rm -rf data params && ln -s "$VOL/data" data && ln -s "$VOL/params" params
[ -n "${BOT_TOKEN:-}" ] && printf %s "$BOT_TOKEN" > ".token-${BOT_NAME:-bot}"
./play.sh &
if [ "${IMPROVE:-1}" = "1" ]; then
  WORKERS=${WORKERS:-2} GENS=${GENS:-6} POP=${POP:-16} SEEDS=${SEEDS:-16} ./improve.sh
fi
wait
