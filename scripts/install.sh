#!/bin/bash
# Установка помощника для расширения «Amnezia Browser Client» на macOS и Linux.
#  1. собирает native host (Go) из native-host/;
#  2. собирает wireproxy-awg (userspace AmneziaWG -> SOCKS5) через go install;
#  3. регистрирует native messaging host в Firefox.
# Нужен Go 1.22+. Root не нужен. Повторный запуск обновляет установку.
# Готовые бинарники вместо сборки: HOST_BIN=/путь/awg_host WIREPROXY_BIN=/путь/wireproxy ./scripts/install.sh
# Для Windows — scripts/windows/install.ps1.
set -euo pipefail

WIREPROXY_VERSION="${WIREPROXY_VERSION:-v1.0.18}"
EXT_ID="awg-browser@borisgb2001.github.io"
HOST_NAME="awg_firefox"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support/AWG-Firefox"
    MOZ_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  Linux)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}/awg-browser"
    MOZ_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
  *) echo "Неподдерживаемая система: $(uname -s). Для Windows используйте scripts/windows/install.ps1." >&2; exit 1 ;;
esac

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$BASE/bin" "$BASE/host" "$BASE/profiles" "$BASE/run" "$BASE/logs" "$MOZ_DIR"
chmod 700 "$BASE" "$BASE/profiles" "$BASE/run"

GO="$(command -v go || true)"
need_go() { [ -n "$GO" ] || die "Нужен Go 1.22+ (macOS: brew install go; Linux: пакет golang) либо готовые HOST_BIN / WIREPROXY_BIN."; }

# --- native host ----------------------------------------------------------
[ -x "$BASE/host/awg_host" ] && "$BASE/host/awg_host" --stop 2>/dev/null || true  # остановить туннель
# В версии 1.0 awg_host был bash-обёрткой над Python; go build не перезаписывает такие файлы.
rm -f "$BASE/host/awg_host" "$BASE/host/awg_host.py"
if [ -n "${HOST_BIN:-}" ]; then
  cp "$HOST_BIN" "$BASE/host/awg_host"
else
  need_go
  say "Сборка помощника (native-host, Go)…"
  (cd "$PROJECT/native-host" && CGO_ENABLED=0 "$GO" build -trimpath -ldflags "-s -w" -o "$BASE/host/awg_host" .)
fi
chmod 755 "$BASE/host/awg_host"
say "Помощник: $("$BASE/host/awg_host" --version)"

# --- wireproxy-awg --------------------------------------------------------
# Старый файл удаляем, а не перезаписываем: на macOS запись поверх подписанного бинарника,
# который уже запускался, приводит к SIGKILL (ядро кэширует подпись по inode).
rm -f "$BASE/bin/wireproxy"
if [ -n "${WIREPROXY_BIN:-}" ]; then
  cp "$WIREPROXY_BIN" "$BASE/bin/wireproxy"
else
  need_go
  say "Сборка wireproxy-awg $WIREPROXY_VERSION (go install)…"
  GOBIN="$BASE/bin" CGO_ENABLED=0 "$GO" install -trimpath -ldflags "-s -w" \
    "github.com/artem-russkikh/wireproxy-awg/cmd/wireproxy@$WIREPROXY_VERSION"
fi
chmod 755 "$BASE/bin/wireproxy"
say "wireproxy: $("$BASE/bin/wireproxy" -v 2>&1 | head -1)"

# --- registration ---------------------------------------------------------
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
printf '{\n  "wireproxy": "%s"\n}\n' "$(json_escape "$BASE/bin/wireproxy")" > "$BASE/host.json"
cat > "$MOZ_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Amnezia Browser Client: управление wireproxy-awg",
  "path": "$(json_escape "$BASE/host/awg_host")",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
say "Native host зарегистрирован: $MOZ_DIR/$HOST_NAME.json"

printf '    self-test: '
"$BASE/host/awg_host" --self-test >/dev/null && echo OK || die "помощник не прошёл самопроверку: $("$BASE/host/awg_host" --self-test)"

say "Готово. Перезапустите Firefox и установите расширение (см. README.md)."
