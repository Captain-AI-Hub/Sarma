# Sarma installer/updater (Windows).
#
#   iex (irm https://raw.githubusercontent.com/Captain-AI-Hub/Sarma/main/install.ps1)
#
# Pin a version:  $env:SARMA_VERSION = 'v0.2.0'; iex (irm ...install.ps1)
# Uninstall:      $env:SARMA_UNINSTALL = '1'; iex (irm ...install.ps1)
#
# What it does: installs Bun if missing, downloads the latest tagged source
# (falling back to main when the tag predates the build script), compiles the
# standalone binary, and installs it to %LOCALAPPDATA%\Sarma\bin (added to the
# user PATH). Re-running updates.
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    Write-Error 'This installer is for Windows. On Linux/macOS use install.sh.'
    exit 1
}

$Repo = 'Captain-AI-Hub/Sarma'
$AppDir = Join-Path $env:LOCALAPPDATA 'Sarma'
$SrcDir = Join-Path $AppDir 'src'
$BinDir = Join-Path $AppDir 'bin'

function Uninstall-Sarma {
    Write-Host '==>' 'Removing Sarma'
    if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath) {
        $parts = $userPath -split ';' | Where-Object { $_ -ne '' -and $_ -ne $BinDir }
        [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    }
    Write-Host '==>' 'Done. Config under ~\.sarma was left untouched.'
    exit 0
}

if ($env:SARMA_UNINSTALL -eq '1' -or ($args.Count -gt 0 -and $args[0] -eq 'uninstall')) {
    Uninstall-Sarma
}

# ---------------------------------------------------------------- version ---
$Version = if ($env:SARMA_VERSION) { $env:SARMA_VERSION }
           elseif ($args.Count -gt 0) { $args[0] }
           elseif (Get-Command git -ErrorAction SilentlyContinue) {
               # Prefer git ls-remote (no rate limits, semver-sorted).
               $tag = & git ls-remote --tags --refs --sort=-v:refname "https://github.com/$Repo.git" 'v*' 2>$null |
                   Select-Object -First 1
               if ($tag -and $tag -match 'refs/tags/(.+)$') { $Matches[1] } else { 'main' }
           }
           else {
               try {
                   (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/tags" -ErrorAction Stop)[0].name
               } catch { 'main' }
           }

function Get-ArchiveUrl([string]$Version) {
    if ($Version -eq 'main') {
        "https://github.com/$Repo/archive/refs/heads/main.tar.gz"
    } else {
        "https://github.com/$Repo/archive/refs/tags/$Version.tar.gz"
    }
}

function Get-Source([string]$Version) {
    if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir }
    New-Item -ItemType Directory -Force -Path $SrcDir | Out-Null
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "sarma-$Version.tar.gz"
    Invoke-WebRequest -Uri (Get-ArchiveUrl $Version) -OutFile $tmp -UseBasicParsing
    # Windows 10+ ships bsdtar as tar.exe; it handles .tar.gz directly.
    & tar -xzf $tmp -C $SrcDir --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'failed to extract Sarma source archive' }
    Remove-Item -Force $tmp
}

# -------------------------------------------------------------------- bun ---
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host '==>' 'Installing Bun'
    Invoke-RestMethod -Uri https://bun.sh/install.ps1 | Invoke-Expression
}
$env:PATH = "$HOME\.bun\bin;$env:PATH"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'Bun is installed but not on PATH. Open a new terminal and re-run.'
}

# ------------------------------------------------------------------ source ---
Write-Host '==>' "Downloading Sarma $Version"
Get-Source $Version
# Tags cut before the standalone build existed (pre-0.2.1) cannot be compiled.
if (-not (Test-Path (Join-Path $SrcDir 'scripts/build.ts'))) {
    Write-Host '==>' "Tag $Version has no build script; falling back to main"
    $Version = 'main'
    Get-Source $Version
}

# ------------------------------------------------------------------- build ---
Write-Host '==>' 'Installing dependencies'
Push-Location $SrcDir
try {
    & bun install
    if ($LASTEXITCODE -ne 0) { throw 'bun install failed' }

    Write-Host '==>' 'Compiling standalone binary'
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw 'bun run build failed' }

    $built = Join-Path $SrcDir 'dist/sarma.exe'
    if (-not (Test-Path $built)) { $built = Join-Path $SrcDir 'dist/sarma' }
    if (-not (Test-Path $built)) { throw 'build did not produce dist/sarma(.exe)' }

    # ----------------------------------------------------------------- install ---
    Write-Host '==>' "Installing to $BinDir\sarma.exe"
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Copy-Item -Force $built (Join-Path $BinDir 'sarma.exe')
} finally {
    Pop-Location
}

# PATH (persistent, user scope)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$inPath = ($userPath -split ';') -contains $BinDir
if (-not $inPath) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
    Write-Host '==>' "Added $BinDir to the user PATH (restart your terminal)"
}

Write-Host '==>' "Installed Sarma $(& (Join-Path $BinDir 'sarma.exe') --version)"
