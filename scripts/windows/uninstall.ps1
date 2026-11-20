# Удаление помощника «Amnezia Browser Client» (Windows). Профили (конфиги с ключами)
# удаляются только с флагом -Purge.
param([switch]$Purge)
$ErrorActionPreference = "Stop"
$Base = Join-Path $env:LOCALAPPDATA "AWG-Browser"
$HostExe = Join-Path $Base "host\awg_host.exe"

if (Test-Path $HostExe) { & $HostExe --stop | Out-Null; Write-Host "Туннель остановлен." }
Remove-Item -Force -ErrorAction SilentlyContinue -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\awg_firefox"
foreach ($p in @("bin", "host", "run", "host.json", "awg_firefox.json")) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path (Join-Path $Base $p)
}
if ($Purge) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path $Base
    Write-Host "Удалено всё, включая профили."
} else {
    Write-Host "Помощник удалён. Профили остались в: $Base\profiles (удалить: uninstall.ps1 -Purge)"
}
