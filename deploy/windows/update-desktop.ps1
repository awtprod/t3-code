<#
.SYNOPSIS
  Update the Command Center desktop app on Windows: pull latest, build the
  NSIS installer, close the running app, and install.

.DESCRIPTION
  Automates the manual flow (git pull -> pnpm install -> dist:desktop:win ->
  run installer). Run from anywhere inside the repo clone, or double-click
  update-desktop.cmd next to this file.

.PARAMETER CheckOnly
  Report whether origin has new commits; change nothing.
.PARAMETER Silent
  Install unattended (NSIS /S) and relaunch the app afterwards.
.PARAMETER SkipInstall
  Pull and build only; leave the installer in release\ without running it.
.PARAMETER Branch
  Branch to update from (default: main).
.PARAMETER Arch
  Build architecture (default: x64).
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$Silent,
  [switch]$SkipInstall,
  [string]$Branch = "main",
  [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"

function Log([string]$msg) {
  Write-Host ("{0:u} {1}" -f (Get-Date), $msg)
}
function Fail([string]$msg) {
  Write-Error $msg
  exit 1
}

# --- locate repo root (this script lives at <repo>\deploy\windows) ----------
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not (Test-Path (Join-Path $RepoRoot "pnpm-workspace.yaml"))) {
  Fail "repo root not found at $RepoRoot (expected pnpm-workspace.yaml)"
}
Set-Location $RepoRoot

foreach ($tool in @("git", "node", "pnpm")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "$tool not found on PATH"
  }
}

# --- git state --------------------------------------------------------------
$dirty = git status --porcelain
if ($dirty) {
  Fail "working tree is dirty; commit or stash before updating:`n$dirty"
}
$currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($currentBranch -ne $Branch) {
  Fail "on branch '$currentBranch', expected '$Branch' (pass -Branch to override)"
}

Log "fetching origin/$Branch"
git fetch origin $Branch
if ($LASTEXITCODE -ne 0) { Fail "git fetch failed" }

$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse "origin/$Branch").Trim()

if ($CheckOnly) {
  Log "local:  $local"
  Log "remote: $remote"
  if ($local -eq $remote) { Log "status: up to date" } else { Log "status: update available" }
  exit 0
}

$upToDate = ($local -eq $remote)
if (-not $upToDate) {
  Log "updating $local -> $remote"
  git merge --ff-only "origin/$Branch"
  if ($LASTEXITCODE -ne 0) { Fail "fast-forward merge failed (diverged history?)" }
}

# --- resolve expected artifact ---------------------------------------------
$serverPkg = Get-Content (Join-Path $RepoRoot "apps\server\package.json") -Raw | ConvertFrom-Json
$version = $serverPkg.version
$releaseDir = Join-Path $RepoRoot "release"
$installerName = "Command-Center-$version-$Arch.exe"
$installerPath = Join-Path $releaseDir $installerName

if ($upToDate -and (Test-Path $installerPath)) {
  Log "already up to date and installer for $version exists at $installerPath"
  if ($SkipInstall) { exit 0 }
  Log "reinstalling existing artifact"
} else {
  # --- build ----------------------------------------------------------------
  # CI=true keeps pnpm non-interactive; GITHUB_REPOSITORY feeds the updater
  # feed config baked into the app (optional, but correct for this fork).
  $env:CI = "true"
  $env:GITHUB_REPOSITORY = "awtprod/t3-code"

  Log "installing dependencies (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" }

  Log "building Windows installer (this takes a while)"
  if ($Arch -eq "arm64") {
    pnpm run dist:desktop:win:arm64
  } else {
    pnpm run dist:desktop:win:x64
  }
  if ($LASTEXITCODE -ne 0) { Fail "desktop build failed" }

  if (-not (Test-Path $installerPath)) {
    # Fall back to the newest matching artifact in case the version moved
    # during the build (nightly stamping).
    $candidate = Get-ChildItem $releaseDir -Filter "Command-Center-*-$Arch.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) { Fail "no installer found in $releaseDir after build" }
    $installerPath = $candidate.FullName
  }
}

Log "installer: $installerPath"
if ($SkipInstall) {
  Log "-SkipInstall set; build complete, installer not run"
  exit 0
}

# --- close the running app --------------------------------------------------
$procs = Get-Process "Command Center" -ErrorAction SilentlyContinue
if ($procs) {
  Log "closing running Command Center ($($procs.Count) process(es))"
  $procs | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  $procs | ForEach-Object { $_.WaitForExit(10000) | Out-Null }
  $remaining = Get-Process "Command Center" -ErrorAction SilentlyContinue
  if ($remaining) {
    Log "forcing remaining process(es) to stop"
    $remaining | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
}

# --- install ----------------------------------------------------------------
if ($Silent) {
  Log "installing silently"
  Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait
  # Default electron-builder NSIS per-user install location.
  $appExe = Join-Path $env:LOCALAPPDATA "Programs\Command Center\Command Center.exe"
  if (Test-Path $appExe) {
    Log "relaunching $appExe"
    Start-Process -FilePath $appExe
  } else {
    Log "WARNING: app exe not found at $appExe; launch it manually"
  }
} else {
  Log "launching installer (interactive)"
  Start-Process -FilePath $installerPath -Wait
}

Log "desktop update complete (version $version)"
exit 0
