#!/bin/bash
# Установка помощника для расширения «Amnezia Browser Client» (macOS).
#  1. собирает wireproxy-awg (userspace AmneziaWG -> SOCKS5) из исходников, нужен Go;
#  2. копирует native-host (Python 3) в ~/Library/Application Support/AWG-Firefox;
#  3. регистрирует native messaging host в Firefox.
# Root не нужен. Повторный запуск обновляет установку.
set -euo pipefail

WIREPROXY_VERSION="${WIREPROXY_VERSION:-v1.0.18}"
EXT_ID="awg-browser@borisgb2001.github.io"
HOST_NAME="awg_firefox"

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$HOME/Library/Application Support/AWG-Firefox"
MOZ_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$BASE/bin" "$BASE/host" "$BASE/profiles" "$BASE/run" "$BASE/logs" "$MOZ_DIR"
chmod 700 "$BASE" "$BASE/profiles" "$BASE/run"

# --- Python 3 -------------------------------------------------------------
PYTHON=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$p" ] && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
    PYTHON="$p"; break
  fi
done
[ -n "$PYTHON" ] || die "Нужен Python 3.8+ (brew install python или xcode-select --install)."
say "Python: $PYTHON"

# --- wireproxy-awg --------------------------------------------------------
if [ -n "${WIREPROXY_BIN:-}" ]; then
  [ -x "$WIREPROXY_BIN" ] || die "WIREPROXY_BIN=$WIREPROXY_BIN не исполняемый файл."
  cp "$WIREPROXY_BIN" "$BASE/bin/wireproxy"
  say "wireproxy-awg скопирован из $WIREPROXY_BIN"
else
  GO="$(command -v go || true)"
  [ -n "$GO" ] || die "Нужен Go (brew install go) либо готовый бинарник: WIREPROXY_BIN=/путь/к/wireproxy $0"
  say "Сборка wireproxy-awg $WIREPROXY_VERSION (go install)…"
  GOBIN="$BASE/bin" CGO_ENABLED=0 "$GO" install -trimpath -ldflags "-s -w" \
    "github.com/artem-russkikh/wireproxy-awg/cmd/wireproxy@$WIREPROXY_VERSION"
fi
chmod 755 "$BASE/bin/wireproxy"
say "wireproxy: $("$BASE/bin/wireproxy" -v 2>&1 | head -1)"

# --- native host ----------------------------------------------------------
cp "$PROJECT/native-host/awg_host.py" "$BASE/host/awg_host.py"
cat > "$BASE/host/awg_host" <<EOF
#!/bin/bash
# Обёртка native messaging host: Firefox запускает её с урезанным PATH.
exec "$PYTHON" "$BASE/host/awg_host.py" "\$@"
EOF
chmod 755 "$BASE/host/awg_host" "$BASE/host/awg_host.py"

"$PYTHON" - "$BASE/host.json" "$BASE/bin/wireproxy" <<'EOF'
import json, sys
json.dump({"wireproxy": sys.argv[2]}, open(sys.argv[1], "w"), indent=2)
EOF

"$PYTHON" - "$MOZ_DIR/$HOST_NAME.json" "$BASE/host/awg_host" "$HOST_NAME" "$EXT_ID" <<'EOF'
import json, sys
path, exe, name, ext = sys.argv[1:]
json.dump({
    "name": name,
    "description": "AmneziaWG для Firefox: управление wireproxy-awg",
    "path": exe,
    "type": "stdio",
    "allowed_extensions": [ext],
}, open(path, "w"), indent=2)
EOF
say "Native host зарегистрирован: $MOZ_DIR/$HOST_NAME.json"

# --- self-test ------------------------------------------------------------
"$PYTHON" - "$BASE/host/awg_host" <<'EOF'
import json, struct, subprocess, sys
msg = json.dumps({"cmd": "ping"}).encode()
out = subprocess.run([sys.argv[1]], input=struct.pack("@I", len(msg)) + msg,
                     capture_output=True, timeout=20).stdout
res = json.loads(out[4:4 + struct.unpack("@I", out[:4])[0]])
print("    self-test:", "OK" if res.get("ok") and res.get("wireproxy") else res)
EOF

say "Готово. Перезапустите Firefox и установите расширение (см. README.md)."
