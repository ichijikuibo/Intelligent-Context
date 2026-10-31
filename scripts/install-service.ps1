# PowerShell — Install Intelligent Context as a Windows Service
# Run as Administrator
#
# Uses the single executable (SEA) binary produced by `npm run build:sea`.
# The binary embeds Node.js — no separate runtime needed.
#
# USAGE:
#   .\scripts\install-service.ps1 -Action install
#   .\scripts\install-service.ps1 -Action uninstall
#   .\scripts\install-service.ps1 -Action status
#
# The first run will build the SEA binary if it doesn't exist yet.
# For distribution, ship the pre-built binary + ui/ + sql-wasm.wasm and
# set -BinaryPath explicitly.

param(
  [string]$Action = "install",
  [string]$ServiceName = "IntelligentContext",
  [string]$AppDir = $PSScriptRoot + "\..",
  [string]$BinaryPath = ""
)

$AppDir = (Resolve-Path $AppDir).Path

# Resolve the single executable
if ($BinaryPath) {
  $ExePath = $BinaryPath
} else {
  $ExePath = Join-Path $AppDir "dist\sea\intelligent-context.exe"
}

if ($Action -eq "install") {
  # Build the SEA binary if it doesn't exist
  if (-not (Test-Path $ExePath)) {
    Write-Host "Single executable not found. Building..."
    Push-Location $AppDir
    try {
      npm ci
      npm run build:sea
    } finally {
      Pop-Location
    }
    if (-not (Test-Path $ExePath)) {
      Write-Error "Build failed. Check output above."
      exit 1
    }
  }

  Write-Host "Installing service from: $ExePath"

  # Try NSSM first (recommended)
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if ($nssm) {
    Write-Host "Installing via NSSM..."
    & nssm install $ServiceName $ExePath
    & nssm set $ServiceName AppDirectory (Split-Path $ExePath -Parent)
    & nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production NODE_NO_WARNINGS=1 IC_AUTO_RESTART=1"
    & nssm set $ServiceName Description "Intelligent Context AI Proxy"
    & nssm set $ServiceName Start SERVICE_AUTO_START
    & nssm start $ServiceName
    Write-Host "Service '$ServiceName' installed and started."
  } else {
    Write-Host "NSSM not found. Installing via sc.exe (basic)..."
    Write-Host "Tip: Install NSSM from https://nssm.cc for better service management."
    sc.exe create $ServiceName binPath= "`"$ExePath`"" start= auto DisplayName= "Intelligent Context"
    sc.exe start $ServiceName
    Write-Host "Service '$ServiceName' installed."
  }

  Write-Host ""
  Write-Host "Proxy: http://localhost:1234/v1"
  Write-Host "Management UI: http://localhost:9090/ui"

} elseif ($Action -eq "uninstall") {
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if ($nssm) {
    & nssm stop $ServiceName
    & nssm remove $ServiceName confirm
  } else {
    sc.exe stop $ServiceName
    sc.exe delete $ServiceName
  }
  Write-Host "Service '$ServiceName' removed."

} elseif ($Action -eq "status") {
  Get-Service -Name $ServiceName -ErrorAction SilentlyContinue | Format-Table -AutoSize
}
