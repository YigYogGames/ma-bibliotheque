#!/usr/bin/env bash
# Lance une commande ; en cas d'échec, remonte la fin du journal sous forme d'annotations GitHub.
set -o pipefail
log=$(mktemp)
bash -c "$1" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  # 8 blocs de 40 lignes max, lisibles via l'API des annotations
  tail -n 320 "$log" | grep -v '^\s*$' | tail -n 320 | split -l 40 - /tmp/chunk_
  for f in /tmp/chunk_*; do
    msg=$(sed -e 's/%/%25/g' "$f" | awk '{printf "%s%%0A", $0}')
    echo "::error title=Journal ($(basename "$f"))::$msg"
  done
fi
exit "$code"
