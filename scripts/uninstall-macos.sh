#!/bin/bash
# Удаление помощника «AmneziaWG для Firefox». Профили (конфиги с ключами)
# удаляются только с флагом --purge.
set -euo pipefail
BASE="$HOME/Library/Application Support/AWG-Firefox"
MANIFEST="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/awg_firefox.json"

if [ -f "$BASE/run/state.json" ]; then
  PID="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",""))' "$BASE/run/state.json" 2>/dev/null || true)"
  if [ -n "$PID" ] && [ "$(ps -p "$PID" -o comm= 2>/dev/null | xargs basename 2>/dev/null)" = "wireproxy" ]; then
    kill "$PID" && echo "Туннель остановлен (pid $PID)"
  fi
fi

rm -f "$MANIFEST"
rm -rf "$BASE/bin" "$BASE/host" "$BASE/run" "$BASE/host.json"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$BASE"
  echo "Удалено всё, включая профили."
else
  echo "Помощник удалён. Профили остались в: $BASE/profiles (удалить: $0 --purge)"
fi
