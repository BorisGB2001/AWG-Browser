#!/bin/bash
# Удаление помощника «Amnezia Browser Client» (macOS, Linux). Профили (конфиги
# с ключами) удаляются только с флагом --purge.
set -euo pipefail
case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support/AWG-Firefox"
    MANIFEST="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/awg_firefox.json" ;;
  *)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}/awg-browser"
    MANIFEST="$HOME/.mozilla/native-messaging-hosts/awg_firefox.json" ;;
esac

[ -x "$BASE/host/awg_host" ] && "$BASE/host/awg_host" --stop && echo "Туннель остановлен."

rm -f "$MANIFEST"
rm -rf "$BASE/bin" "$BASE/host" "$BASE/run" "$BASE/host.json"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$BASE"
  echo "Удалено всё, включая профили."
else
  echo "Помощник удалён. Профили остались в: $BASE/profiles (удалить: $0 --purge)"
fi
