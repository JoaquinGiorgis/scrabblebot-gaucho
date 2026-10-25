#!/usr/bin/env bash
# En Railway: data/ y params/ viven en el volumen /data para sobrevivir redeploys.
set -u
cd "$(dirname "$0")"
VOL=${RAILWAY_VOLUME_MOUNT_PATH:-/data}
mkdir -p "$VOL/data" "$VOL/params"
# Sembrar el volumen con los campeones de la imagen la primera vez, o cuando
# la imagen trae otra versión (params/VERSION): entonces la imagen manda y la
# política que dejó el asesor en el volumen se guarda aparte.
FORCE=${SEED_PARAMS:-}
if [ -s params/VERSION ] && ! cmp -s params/VERSION "$VOL/params/VERSION"; then
  FORCE=force
  [ -f "$VOL/policy.ts" ] && mv "$VOL/policy.ts" "$VOL/policy.ts.bak-$(date +%s)"
  for f in "$VOL"/params/*.json; do [ -e "$f" ] && cp "$f" "$f.bak-$(date +%s)"; done
  cp params/VERSION "$VOL/params/VERSION"
fi
for f in params/*.json; do [ -e "$f" ] && { [ ! -s "$VOL/$f" ] || [ "$FORCE" = "force" ]; } && cp "$f" "$VOL/$f"; done
rm -rf data params && ln -s "$VOL/data" data && ln -s "$VOL/params" params
# Política aceptada por el asesor LLM (vive en el volumen, no en la imagen).
[ -f "$VOL/policy.ts" ] && cp "$VOL/policy.ts" src/core/policy.ts
export POLICY_STORE="$VOL"
[ -n "${BOT_TOKEN:-}" ] && printf %s "$BOT_TOKEN" > ".token-${BOT_NAME:-bot}"
./play.sh &
if [ "${IMPROVE:-1}" = "1" ]; then
  WORKERS=${WORKERS:-2} GENS=${GENS:-6} POP=${POP:-16} SEEDS=${SEEDS:-16} ./improve.sh
fi
wait
