#Requires -Version 5.1
<#
.SYNOPSIS
  Install and build AnTerm on Windows.

.DESCRIPTION
  Installs Git and Node.js (LTS) via winget if they are missing, clones the
  repository (or uses an existing checkout), runs `npm install`, writes a `.env`
  with freshly generated secrets, and builds the production bundle. Optionally
  starts the server.

.EXAMPLE
  # From a fresh machine (PowerShell, normal user):
  Set-ExecutionPolicy -Scope Process Bypass -Force
  iwr https://raw.githubusercontent.com/AnHuynh07/anterm/main/scripts/install-windows.ps1 -OutFile install-windows.ps1
  .\install-windows.ps1 -Start

.EXAMPLE
  # From inside a clone:
  .\scripts\install-windows.ps1

.NOTES
  better-sqlite3 / argon2 ship prebuilt Windows x64 binaries for the current LTS
  Node versions (20, 22, 24). On a Node version with no prebuild, npm falls back
  to a C++ compile: re-run with -BuildTools, or install an even LTS Node.
  `node-pty` is optional and its build failure is harmless (local-shell mode only).
#>
[CmdletBinding()]
param(
  [string] $Path,
  [string] $Branch = 'main',
  [int]    $Port = 3000,
  [string] $AdminUser = 'admin',
  [string] $AdminPassword,
  [string] $AppSecret,
  [string] $AllowHosts,
  [switch] $AllowTelnet,
  [switch] $NoBuild,
  [switch] $Start,
  [switch] $BuildTools
)

$RepoUrl = 'https://github.com/AnHuynh07/anterm.git'

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  $m" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function New-Hex([int]$bytes = 32) {
  $b = New-Object 'byte[]' $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

function Is-Repo($dir) {
  if (-not $dir) { return $false }
  Test-Path (Join-Path "$dir" 'server\package.json')
}

function Winget-Install($id, $label) {
  if (-not (Have 'winget')) {
    Die "winget is not available. Install '$label' manually (https://nodejs.org , https://git-scm.com), reopen PowerShell, and re-run."
  }
  Info "Installing $label via winget ..."
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
  Refresh-Path
}

Write-Host ""
Write-Host "  AnTerm - Windows installer" -ForegroundColor White
Write-Host "  =========================" -ForegroundColor White
Write-Host ""

# --- 0. Let PowerShell run npm.ps1 for THIS user (so later manual `npm ...` works) ---
try {
  $cur = Get-ExecutionPolicy -Scope CurrentUser
  if ($cur -eq 'Restricted' -or $cur -eq 'Undefined') {
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
    Ok "execution policy (CurrentUser) -> RemoteSigned"
  }
} catch {
  Warn "could not set execution policy (Group Policy?) - use cmd.exe for manual npm commands"
}

# --- 1. Git ---
if (-not (Have 'git')) { Winget-Install 'Git.Git' 'Git' }
if (-not (Have 'git')) { Die "Git still not on PATH. Reopen PowerShell and re-run this script." }
Ok "git  $(git --version)"

# --- 2. Node.js >= 20 ---
$nodeOk = $false
if (Have 'node') {
  $v = (node -v).TrimStart('v')
  if ([int]($v.Split('.')[0]) -ge 20) { $nodeOk = $true; Ok "node v$v" }
  else { Warn "node v$v is too old (need >= 20)" }
}
if (-not $nodeOk) {
  Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not (Have 'node')) { Die "Node.js installed but not on PATH yet. Close this window, open a NEW PowerShell, and re-run the script." }
  $v = (node -v).TrimStart('v')
  if ([int]($v.Split('.')[0]) -lt 20) { Die "Node.js v$v is still < 20. Install the current LTS from https://nodejs.org and re-run." }
  Ok "node v$v"
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor % 2 -ne 0) {
  Warn "node v$nodeMajor is an odd 'Current' release - native module prebuilds may lag."
  Warn "If 'npm install' fails to compile, install an even LTS (22 or 24) instead."
}

# --- 2c. Optional: Visual Studio Build Tools (only needed if a native prebuild is missing) ---
if ($BuildTools) {
  if (Have 'cl') {
    Ok "MSVC compiler already on PATH"
  } elseif (-not (Have 'winget')) {
    Warn "winget missing - install 'Visual Studio Build Tools' + the 'Desktop development with C++' workload manually."
  } else {
    Info "Installing Visual Studio Build Tools with the C++ workload (large download) ..."
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget `
      --accept-package-agreements --accept-source-agreements `
      --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" 2>&1 | Out-Host
    Refresh-Path
  }
}
Ok "npm  v$(npm -v)"

# --- 3. Locate or clone the repo ---
if (-not $Path) {
  if     (Is-Repo (Get-Location).Path) { $Path = (Get-Location).Path }
  elseif ($PSScriptRoot -and (Is-Repo (Join-Path $PSScriptRoot '..'))) { $Path = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  else   { $Path = Join-Path (Get-Location).Path 'anterm' }
}

if (Is-Repo $Path) {
  Info "Using existing checkout: $Path"
  Push-Location $Path
  git fetch --quiet origin $Branch 2>&1 | Out-Null
  git checkout --quiet $Branch    2>&1 | Out-Null
  git pull --quiet --ff-only origin $Branch 2>&1 | Out-Null
} else {
  Info "Cloning into: $Path"
  git clone --branch $Branch --depth 1 $RepoUrl "$Path" 2>&1 | Out-Host
  if (-not (Is-Repo $Path)) { Die "Clone failed - see the output above." }
  Push-Location $Path
}

$GeneratedPassword = $null
try {
  # --- 4. Dependencies ---
  Info "Installing dependencies (npm install) - this can take a few minutes ..."
  npm install --no-fund --no-audit 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Warn "npm install failed. This is almost always a native module (better-sqlite3)"
    Warn "with no prebuilt binary for your Node version, falling back to a C++ compile."
    Warn ""
    Warn "Pick ONE fix:"
    Warn "  1) Use an even LTS Node (recommended):"
    Warn "       winget install CoreyButler.NVMforWindows ; (reopen PowerShell)"
    Warn "       nvm install 22 ; nvm use 22 ; then re-run this script"
    Warn "  2) Install the C++ build tools and let it compile:"
    Warn "       re-run this script with  -BuildTools   (adds ~3-6 GB)"
    Die   "See the log path printed above for details."
  }
  Ok "dependencies installed"

  # --- 4b. Make sure the native binary is really there (some setups defer install scripts) ---
  Info "Checking native modules ..."
  node -e "new (require('better-sqlite3'))(':memory:')" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Info "  building better-sqlite3 ..."
    npm rebuild better-sqlite3 argon2 ssh2 --foreground-scripts 2>&1 | Out-Host
    node -e "new (require('better-sqlite3'))(':memory:')" 2>$null
    if ($LASTEXITCODE -ne 0) {
      Die "better-sqlite3 still won't load. Run with -BuildTools, or use Node 22 LTS (nvm-windows)."
    }
  }
  Ok "native modules OK"

  # --- 5. .env ---
  $envPath = Join-Path $Path '.env'
  if (Test-Path $envPath) {
    Ok ".env already exists - left untouched"
  } else {
    if (-not $AppSecret)     { $AppSecret = New-Hex 32 }
    if (-not $AdminPassword) { $AdminPassword = New-Hex 9 }
    $lines = @(
      "# Generated by install-windows.ps1 on $(Get-Date -Format s)",
      "ANTERM_APP_SECRET=$AppSecret",
      "ANTERM_DB_URL=./data/anterm.sqlite",
      "ANTERM_HOST=0.0.0.0",
      "ANTERM_PORT=$Port",
      "ADMIN_USER=$AdminUser",
      "ADMIN_PASSWORD=$AdminPassword"
    )
    if ($AllowHosts)  { $lines += "ANTERM_ALLOW_HOSTS=$AllowHosts" }
    if ($AllowTelnet) { $lines += "ANTERM_ALLOW_TELNET=true" }
    Set-Content -Path $envPath -Value $lines -Encoding ascii
    Ok ".env written"
    $GeneratedPassword = $AdminPassword
  }

  # --- 6. Build ---
  if ($NoBuild) {
    Warn "Skipped build (-NoBuild). Run 'npm run dev' for the dev server on http://localhost:5173"
  } else {
    Info "Building the production bundle (npm run build) ..."
    npm run build 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "Build failed - see the output above." }
    Ok "build complete"

    $bat = Join-Path $Path 'start-anterm.bat'
    Set-Content -Path $bat -Encoding ascii -Value @(
      '@echo off',
      'cd /d "%~dp0"',
      'node server\dist\index.js',
      'pause'
    )
    Ok "created start-anterm.bat"
  }

  # --- 7. Summary ---
  Write-Host ""
  Write-Host "  ------------------------------------------------------------" -ForegroundColor White
  Ok "AnTerm is installed at $Path"
  Write-Host ""
  if ($GeneratedPassword) {
    Write-Host "  Admin login : $AdminUser / $GeneratedPassword" -ForegroundColor White
    Write-Host "  (also in .env - change it right after the first login)" -ForegroundColor DarkGray
  } else {
    Write-Host "  Admin login : from your existing .env" -ForegroundColor White
  }
  Write-Host "  URL         : http://localhost:$Port" -ForegroundColor White
  Write-Host ""
  Write-Host "  Start it:" -ForegroundColor White
  if ($NoBuild) {
    Write-Host "    npm run dev            (then open http://localhost:5173)" -ForegroundColor Gray
  } else {
    Write-Host "    .\start-anterm.bat      -- or --     node server\dist\index.js" -ForegroundColor Gray
  }
  Write-Host ""
  Warn "SECURITY: put AnTerm behind an HTTPS reverse proxy and restrict access"
  Warn "          (VPN / firewall / --allow-hosts) before exposing it."
  Warn "BACKUP:   keep ANTERM_APP_SECRET safe - losing it makes every stored"
  Warn "          SSH credential unrecoverable."
  Write-Host "  ------------------------------------------------------------" -ForegroundColor White
  Write-Host ""

  if ($Start -and -not $NoBuild) {
    Info "Starting server (Ctrl+C to stop) ..."
    node server\dist\index.js
  }
}
finally {
  Pop-Location
}
