# build-all.ps1 - Cross-platform build orchestrator
# ============================================================================
# Builds the single executable for BOTH Windows and Linux, then packages the
# Linux binary into a Docker image - all from one Windows machine with WSL2.
#
# PREREQUISITES:
#   - WSL2 with a Debian (or other) distro
#   - Node.js 20+ installed on WSL Debian:
#       wsl -d Debian
#       curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
#       sudo apt-get install -y nodejs
#   - Docker Desktop with WSL2 integration enabled
#
# USAGE:
#   .\scripts\build-all.ps1                     # Build all three targets
#   .\scripts\build-all.ps1 -SkipWindows         # Skip Windows, build Linux + Docker
#   .\scripts\build-all.ps1 -SkipDocker           # Skip Docker, build binaries only
#   .\scripts\build-all.ps1 -WslDistro Ubuntu     # Use a different WSL distro
#   .\scripts\build-all.ps1 -Clean                # Wipe dist/sea/ before building
#
# OUTPUT:
#   dist/sea/intelligent-context.exe   (Windows binary   ~80 MB)
#   dist/sea/intelligent-context       (Linux binary     ~80 MB)
#   intelligent-context-proxy:latest   (Docker image)

param(
  [switch]$SkipWindows,
  [switch]$SkipLinux,
  [switch]$SkipDocker,
  [switch]$Clean,
  [string]$WslDistro = "Debian"
)

$ErrorActionPreference = "Stop"
$AppDir = (Resolve-Path "$PSScriptRoot\..").Path
$SeaDir = Join-Path $AppDir "dist\sea"
$LinuxBinary = Join-Path $SeaDir "intelligent-context"
$WinBinary = Join-Path $SeaDir "intelligent-context.exe"

# WSL path to the project
$Drive = $AppDir.Substring(0, 1).ToLower()
$Rest = $AppDir.Substring(2).Replace('\', '/')
$WslAppDir = "/mnt/$Drive$Rest"

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-OK   { param($Text) Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn { param($Text) Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Err  { param($Text) Write-Host "  [ERR] $Text" -ForegroundColor Red }

function Format-Size { param($Path)
  if (-not (Test-Path $Path)) { return "???" }
  $mb = (Get-Item $Path).Length / 1MB
  return "{0:N1} MB" -f $mb
}

function Test-WslAvailable {
  try { $null = wsl -d $WslDistro -- echo ok 2>&1; return $true }
  catch { return $false }
}

function Test-WslDockerAvailable {
  try {
    $null = wsl -d $WslDistro -- bash -lc 'docker version >/dev/null 2>&1'
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Write-CapturedOutput { param($Output)
  if (-not $Output) { return }
  $text = ($Output | ForEach-Object { $_.ToString() }) -join "`n"
  Write-Host $text
}

# ===========================================================================
# WINDOWS BUILD
# ===========================================================================

if (-not $SkipWindows) {
  Write-Step "Windows SEA build"

  # Refresh dependencies before the Windows build so platform-specific
  # binaries such as esbuild are restored even after a prior Linux/WSL build.
  Push-Location $AppDir
  try {
    Write-Host "  Installing dependencies for Windows..."
    npm install --prefer-offline | Out-Null
    Write-OK "Dependencies ready for Windows"
  } finally {
    Pop-Location
  }

  Push-Location $AppDir
  try {
    npm run build:sea
    if (Test-Path $WinBinary) {
      Write-OK ("Windows binary: $WinBinary (" + (Format-Size $WinBinary) + ")")
    } else {
      Write-Err "Windows binary not found after build"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Step "Windows SEA build (SKIPPED)"
}

# ===========================================================================
# LINUX BUILD (isolated in WSL native ext4 filesystem)
# ===========================================================================

if (-not $SkipLinux) {
  Write-Step "Linux SEA build (WSL2: $WslDistro)"

  if (-not (Test-WslAvailable)) {
    Write-Err "WSL distro '$WslDistro' is not running or not available."
    exit 1
  }

  $nodeCheck = wsl -d $WslDistro -- bash -c 'which node || echo MISSING'
  if ($nodeCheck -match "MISSING") {
    Write-Err "Node.js not found in WSL $WslDistro."
    Write-Host "  Install: wsl -d $WslDistro"
    Write-Host "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -"
    Write-Host "  sudo apt-get install -y nodejs"
    exit 1
  }
  Write-OK "Node.js found: $($nodeCheck.Trim())"

  if ($Clean) {
    Write-Host "  Cleaning dist/sea/..."
    if (Test-Path $SeaDir) { Remove-Item $SeaDir -Recurse -Force -ErrorAction SilentlyContinue }
  }

  # The WSL build runs entirely inside WSL's native /tmp (ext4), NOT on
  # the /mnt/d/ mount.  This avoids:
  #   1. Platform binary corruption (esbuild ELF vs PE)
  #   2. postject hanging on cross-filesystem binary patching
  #   3. npm EIO errors from NTFS-in-WSL locking

  Write-Host "  Copying source to WSL native /tmp/ic-build..."
  $wslScriptWindows = Join-Path $env:TEMP "ic-build-linux.sh"
  $wslScriptLines = @(
    'set -e',
    "SOURCE_DIR='$WslAppDir'",
    'BUILD_DIR=/tmp/ic-build',
    'rm -rf "$BUILD_DIR"',
    'mkdir -p "$BUILD_DIR"',
    'for d in src scripts ui; do cp -a "$SOURCE_DIR/$d" "$BUILD_DIR/"; done',
    'cp "$SOURCE_DIR/package.json" "$BUILD_DIR/"',
    'cp "$SOURCE_DIR/package-lock.json" "$BUILD_DIR/"',
    'cp "$SOURCE_DIR/tsconfig.json" "$BUILD_DIR/"',
    'cd "$BUILD_DIR"',
    'echo "  Installing dependencies..."',
    'npm install --prefer-offline',
    'echo "  Running SEA build..."',
    'set +e',
    'npm run build:sea',
    'BUILD_EXIT=$?',
    'echo "  build:sea exit code: $BUILD_EXIT"',
    'if [ "$BUILD_EXIT" -ne 0 ]; then exit "$BUILD_EXIT"; fi',
    'set -e',
    'echo "  Copying results back..."',
    'mkdir -p "$SOURCE_DIR/dist/sea"',
    'cp "$BUILD_DIR/dist/sea/intelligent-context" "$SOURCE_DIR/dist/sea/"',
    'rm -rf "$SOURCE_DIR/dist/sea/ui"',
    'cp -a "$BUILD_DIR/dist/sea/ui" "$SOURCE_DIR/dist/sea/"',
    'cp "$BUILD_DIR/dist/sea/sql-wasm.wasm" "$SOURCE_DIR/dist/sea/"',
    'rm -rf "$BUILD_DIR"',
    'echo BUILD_COMPLETE'
  )
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($wslScriptWindows, ($wslScriptLines -join "`n"), $utf8NoBom)
  $scriptDrive = $wslScriptWindows.Substring(0, 1).ToLower()
  $scriptRest = $wslScriptWindows.Substring(2).Replace('\', '/')
  $wslScriptPath = "/mnt/$scriptDrive$scriptRest"

  try {
    $result = wsl -d $WslDistro -- bash $wslScriptPath
  } finally {
    Remove-Item $wslScriptWindows -Force -ErrorAction SilentlyContinue
  }
  if ($LASTEXITCODE -ne 0) {
    Write-CapturedOutput $result
    Write-Err "Linux SEA build failed. See output above."
    exit 1
  }
  Write-CapturedOutput $result

  if (Test-Path $LinuxBinary) {
    Write-OK ("Linux binary: $LinuxBinary (" + (Format-Size $LinuxBinary) + ")")
  } else {
    Write-Err "Linux binary not found after WSL build"
    exit 1
  }
} else {
  Write-Step "Linux SEA build (SKIPPED)"
}

# ===========================================================================
# DOCKER BUILD
# ===========================================================================

if (-not $SkipDocker) {
  Write-Step "Docker image build (WSL2: $WslDistro)"

  if (-not (Test-WslAvailable)) {
    Write-Err "WSL distro '$WslDistro' is not running or not available."
    exit 1
  }

  if (-not (Test-Path $LinuxBinary)) {
    Write-Err "Linux binary not found. Build it first (remove -SkipLinux)."
    exit 1
  }

  if (Test-WslDockerAvailable) {
    Write-Host "  Building Docker image inside WSL..."
    $dockerCmd = "cd '$WslAppDir' && docker compose build --no-cache"
    $result = wsl -d $WslDistro -- bash -lc $dockerCmd
    if ($LASTEXITCODE -ne 0) {
      if ($result) { Write-CapturedOutput $result }
      Write-Err "Docker build failed inside WSL. See output above."
      exit 1
    }
    Write-CapturedOutput $result
    Write-OK "Docker image built inside WSL: intelligent-context-proxy:latest"
  } else {
    Write-Warn "Docker is not available in WSL distro '$WslDistro'."
    Write-Host "  Enable Docker Desktop WSL integration for that distro to build fully inside WSL."
    Write-Host "  Falling back to host Docker engine..."
    Push-Location $AppDir
    try {
      docker compose build --no-cache
      if ($LASTEXITCODE -ne 0) {
        Write-Err "Docker build failed on the host. See output above."
        exit 1
      }
    } finally {
      Pop-Location
    }
    Write-OK "Docker image built on host Docker engine: intelligent-context-proxy:latest"
  } 
} else {
  Write-Step "Docker image build (SKIPPED)"
}

# ===========================================================================
# SUMMARY
# ===========================================================================

Write-Host "`n=== Build Summary ===" -ForegroundColor Cyan

if (Test-Path $WinBinary) {
  Write-Host ("  Windows:  $WinBinary (" + (Format-Size $WinBinary) + ")") -ForegroundColor Green
} else {
  Write-Host "  Windows:  (not built)" -ForegroundColor DarkGray
}

if (Test-Path $LinuxBinary) {
  Write-Host ("  Linux:    $LinuxBinary (" + (Format-Size $LinuxBinary) + ")") -ForegroundColor Green
} else {
  Write-Host "  Linux:    (not built)" -ForegroundColor DarkGray
}

$dc = if (-not $SkipDocker) { "Green" } else { "DarkGray" }
Write-Host "  Docker:   intelligent-context-proxy:latest" -ForegroundColor $dc

Write-Host "`nTo distribute:" -ForegroundColor Yellow
Write-Host "  Windows: ship intelligent-context.exe + ui/ + sql-wasm.wasm + intelligent-context.yaml"
Write-Host "  Linux:   ship intelligent-context + ui/ + sql-wasm.wasm + intelligent-context.yaml"
Write-Host "  Docker:  docker tag intelligent-context-proxy your-registry/intelligent-context:latest && docker push"
