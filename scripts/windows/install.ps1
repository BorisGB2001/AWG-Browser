# Установка помощника для расширения «Amnezia Browser Client» на Windows.
#  1. копирует awg_host.exe (native host) в %LOCALAPPDATA%\AWG-Browser\host;
#  2. ставит wireproxy-awg (userspace AmneziaWG -> SOCKS5): wireproxy.exe рядом со скриптом,
#     параметр -WireproxyExe или загрузка официального релиза с GitHub со сверкой SHA-256;
#  3. регистрирует native messaging host в Firefox (HKCU, права администратора не нужны).
# Запуск: двойной щелчок по install.cmd или
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
param(
    [string]$WireproxyExe = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$WireproxyVersion = "v1.0.18"
# SHA-256 из checksums.txt релиза artem-russkikh/wireproxy-awg v1.0.18
$WireproxySha256 = "0b7c5e72930196b2b3e0c1d79068fad706148e4b5bbe44c8ee6374caf2c3b8b7"
$WireproxyUrl = "https://github.com/artem-russkikh/wireproxy-awg/releases/download/$WireproxyVersion/wireproxy_windows_amd64.tar.gz"
$ExtId = "awg-browser@borisgb2001.github.io"
$HostName = "awg_firefox"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base = Join-Path $env:LOCALAPPDATA "AWG-Browser"
$HostDir = Join-Path $Base "host"
$BinDir = Join-Path $Base "bin"

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }
function Die($m) { Write-Host "Ошибка: $m" -ForegroundColor Red; exit 1 }

foreach ($d in @($Base, $HostDir, $BinDir, (Join-Path $Base "profiles"), (Join-Path $Base "run"), (Join-Path $Base "logs"))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# Остановить работающий туннель, иначе exe-файлы заняты.
$OldHost = Join-Path $HostDir "awg_host.exe"
if (Test-Path $OldHost) { & $OldHost --stop | Out-Null }

# --- native host ----------------------------------------------------------
$SrcHost = Join-Path $Here "awg_host.exe"
if (-not (Test-Path $SrcHost)) { Die "Рядом со скриптом нет awg_host.exe. Распакуйте весь архив." }
Copy-Item -Force $SrcHost $OldHost
Unblock-File $OldHost
Say "Помощник: $((& $OldHost --version | Out-String).Trim())"

# --- wireproxy-awg --------------------------------------------------------
$Wireproxy = Join-Path $BinDir "wireproxy.exe"
if (-not $WireproxyExe -and (Test-Path (Join-Path $Here "wireproxy.exe"))) { $WireproxyExe = Join-Path $Here "wireproxy.exe" }
if ($WireproxyExe) {
    Copy-Item -Force $WireproxyExe $Wireproxy
} else {
    Say "Загрузка wireproxy-awg $WireproxyVersion с GitHub…"
    $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("awg-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $Tmp | Out-Null
    try {
        $Archive = Join-Path $Tmp "wireproxy.tar.gz"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $WireproxyUrl -OutFile $Archive
        $Hash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLower()
        if ($Hash -ne $WireproxySha256) { Die "Контрольная сумма wireproxy не совпала ($Hash). Загрузка прервана." }
        tar.exe -xzf $Archive -C $Tmp
        if ($LASTEXITCODE -ne 0) { Die "Не удалось распаковать архив wireproxy (нужен Windows 10 1803+ с tar.exe)." }
        $Found = Get-ChildItem -Path $Tmp -Recurse -Filter "wireproxy.exe" | Select-Object -First 1
        if (-not $Found) { Die "В архиве нет wireproxy.exe." }
        Copy-Item -Force $Found.FullName $Wireproxy
    } finally {
        Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
    }
}
Unblock-File $Wireproxy
Say "wireproxy: $((& $Wireproxy -v 2>&1 | Out-String).Trim())"

# --- registration ---------------------------------------------------------
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $Base "host.json"), (@{ wireproxy = $Wireproxy } | ConvertTo-Json), $Utf8)

$ManifestPath = Join-Path $Base "$HostName.json"
$Manifest = [ordered]@{
    name               = $HostName
    description        = "Amnezia Browser Client: wireproxy-awg helper"
    path               = $OldHost
    type               = "stdio"
    allowed_extensions = @($ExtId)
}
[IO.File]::WriteAllText($ManifestPath, ($Manifest | ConvertTo-Json), $Utf8)

$Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
New-Item -Force -Path $Key | Out-Null
Set-Item -Path $Key -Value $ManifestPath
Say "Native host зарегистрирован: $Key -> $ManifestPath"

$Test = (& $OldHost --self-test | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Die "помощник не прошёл самопроверку: $Test" }
Write-Host "    self-test: OK"
Say "Готово. Перезапустите Firefox и установите расширение (amnezia-browser-client-*.xpi)."
