#!/bin/bash
# Собирает архив для Windows: dist/amnezia-browser-client-<версия>-windows.zip
#   awg_host.exe (Go, windows/amd64; на Windows ARM работает через эмуляцию x64),
#   install.cmd / install.ps1, uninstall.*, README.txt и подписанный .xpi, если он есть в dist/.
# wireproxy.exe установщик скачивает сам со сверкой SHA-256. Для архива без интернета:
#   INCLUDE_WIREPROXY=1 ./scripts/build-windows.sh   (скачает и проверит официальный релиз здесь)
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$PROJECT/extension/manifest.json")"
STAGE="$PROJECT/build/windows-pkg"
OUT="$PROJECT/dist/amnezia-browser-client-$VERSION-windows.zip"

rm -rf "$STAGE" && mkdir -p "$STAGE" "$PROJECT/dist"
(cd "$PROJECT/native-host" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -H windowsgui" -o "$STAGE/awg_host.exe" .)
cp "$PROJECT"/scripts/windows/{install.cmd,install.ps1,uninstall.cmd,uninstall.ps1} "$STAGE/"
sed 's/$/\r/' "$PROJECT/scripts/windows/README.txt" > "$STAGE/README.txt"

SIGNED="$PROJECT/dist/amnezia-browser-client-$VERSION-signed.xpi"
if [ -f "$SIGNED" ]; then cp "$SIGNED" "$STAGE/"; else echo "Внимание: нет $SIGNED — архив без расширения." >&2; fi

if [ "${INCLUDE_WIREPROXY:-}" = 1 ]; then
  URL="$(sed -n 's/^\$WireproxyUrl = "\(.*\)"$/\1/p' "$PROJECT/scripts/windows/install.ps1" | sed 's/\$WireproxyVersion/v1.0.18/')"
  SHA="$(sed -n 's/^\$WireproxySha256 = "\(.*\)"$/\1/p' "$PROJECT/scripts/windows/install.ps1")"
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" -o "$TMP/wp.tar.gz"
  echo "$SHA  $TMP/wp.tar.gz" | shasum -a 256 -c -
  tar -xzf "$TMP/wp.tar.gz" -C "$TMP"
  cp "$(find "$TMP" -name wireproxy.exe | head -1)" "$STAGE/wireproxy.exe"
  rm -rf "$TMP"
fi

rm -f "$OUT"
(cd "$STAGE" && zip -qr -X "$OUT" .)
echo "$OUT"
unzip -l "$OUT"
