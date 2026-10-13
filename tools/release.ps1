<#
.SYNOPSIS
  Fin.AI PWA release streamliner - the only allowed way to stamp a release
  and run the gates (project discipline: AGENTS.md "Push & ordering
  discipline").

.DESCRIPTION
  tools\release.ps1 vN.M
    STAMPS, then runs the FULL gate suite, in one pass:
      STAMP  app.js            SHELL_RELEASE { v: N.M, live: new Date(...) }
      STAMP  sw.js             CACHE = 'finances-pwa-vN.M'
      STAMP  README.md         the finances-pwa-vN.M reference
      STAMP  tools/check_site.py  version assertions (sw cache + footer)
      SYNC   ..\check_site.py  + ..\test_chat_parser.py  (root mirrors;
               the mirror SITE line points at .\finance-app)
      GATES  python tools\check_site.py             (repo copy)
             python check_site.py                   (root mirror)
             python tools\test_chat_parser.py
             node --check app.js chat.js ai.js sw.js
             node tools\smoke\smoke_v68.js + tools\smoke\smoke_app_v68.js
               (repo-tracked since v73.48 — the loose finances/ copies were
               the ones the v73.42 incident destroyed; the preflight gate
               below fails at the TOP if any dependency is missing)
    The live stamp is ALWAYS the current time (the HH:MM parameter and the
    "live re-stamp" second commit were dropped in v73.47 — the release is
    ONE commit: run this script right before commit+push so `live` is
    minutes-old at push time; check_site.py's freshness check enforces
    that, and a post-push live fetch verifies the dot is serving).
    Stamping is idempotent (re-running the same dot is safe). Exit 0 =
    green (safe to commit + push); 1 = red (fix and re-run; never push
    past a red gate); 2 = usage/stamp error.

  tools\release.ps1 -GatesOnly
    Re-run the gate suite without touching any stamp.

.EXAMPLE
  tools\release.ps1 v72.1
  tools\release.ps1 -GatesOnly
#>
param(
  [string]$Version = "",
  [switch]$GatesOnly
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot   # finance-app/
$root = Split-Path -Parent $repo           # finances/ (mirrors + smokes)
$script:fail = 0
$utf8 = New-Object System.Text.UTF8Encoding($false)   # UTF-8, no BOM

function Read-Text([string]$p) { [System.IO.File]::ReadAllText($p) }
function Write-Text([string]$p, [string]$t) { [System.IO.File]::WriteAllText($p, $t, $utf8) }
function Bad([string]$msg) {
  Write-Host "FAIL: $msg" -ForegroundColor Red
  exit 2
}

function Gate([string]$name, [scriptblock]$blk) {
  Write-Host ""
  Write-Host "-- $name" -ForegroundColor Cyan
  & $blk
  if ($LASTEXITCODE -ne 0) {
    Write-Host "   [FAIL] $name" -ForegroundColor Red
    $script:fail = 1
  } else {
    Write-Host "   [ok]   $name" -ForegroundColor Green
  }
}

if (-not $GatesOnly) {
  # ------------------------- STAMP -------------------------
  $v = $Version -replace "^v", ""
  if ($v -notmatch "^\d+\.\d+$") { Bad "version must look like v72.1 (got '$Version')" }
  $maj = [int](($v -split "\.")[0])
  $prev = $maj - 1

  # v73.47: the live stamp is always now — the HH:MM parameter is gone
  # (the "live re-stamp" second commit is dead; one commit per release).
  $now = Get-Date
  $H = $now.Hour; $M = $now.Minute
  $dateArg = "$($now.Year), $($now.Month - 1), $($now.Day), $H, $M"

  # 1. app.js - SHELL_RELEASE (v + live)
  $p = Join-Path $repo "app.js"
  $line = "  var SHELL_RELEASE = { v: $v, live: new Date($dateArg) }; // live re-stamped at each push"
  $t = [regex]::Replace((Read-Text $p),
    "(?m)^.*var SHELL_RELEASE = \{ v: [\d.]+, live: new Date\([^)]*\) \};.*$", $line)
  if ($t -notlike "*var SHELL_RELEASE = { v: $v, live: new Date($dateArg) };*") {
    Bad "could not stamp SHELL_RELEASE in app.js"
  }
  Write-Text $p $t
  Write-Host "[stamp] app.js      SHELL_RELEASE v: $v  (live $dateArg)" -ForegroundColor Yellow

  # 2. sw.js - cache name
  $p = Join-Path $repo "sw.js"
  $t = [regex]::Replace((Read-Text $p),
    "const CACHE = 'finances-pwa-v[\d.]+';", "const CACHE = 'finances-pwa-v$v';")
  if ($t -notlike "*const CACHE = 'finances-pwa-v$v';*") {
    Bad "could not stamp CACHE in sw.js"
  }
  Write-Text $p $t
  Write-Host "[stamp] sw.js       CACHE = finances-pwa-v$v" -ForegroundColor Yellow

  # 3. README.md - version reference
  $p = Join-Path $repo "README.md"
  $t = [regex]::Replace((Read-Text $p), "finances-pwa-v[\d.]+", "finances-pwa-v$v")
  if ($t -notlike "*finances-pwa-v$v*") { Bad "could not stamp README.md" }
  Write-Text $p $t
  Write-Host "[stamp] README.md   references finances-pwa-v$v" -ForegroundColor Yellow

  # 4. tools/check_site.py - version assertions (sw cache + footer stamp)
  $p = Join-Path $repo "tools\check_site.py"
  $t = Read-Text $p
  $t = [regex]::Replace($t,
    'check\("sw\.js cache is v\d+ \(dot releases v\d+\.x per subtask\)",',
    ('check("sw.js cache is v' + $maj + ' (dot releases v' + $maj + '.x per subtask)",'))
  $t = [regex]::Replace($t,
    '"finances-pwa-v\d+" in sw and "finances-pwa-v\d+" not in sw',
    ('"finances-pwa-v' + $maj + '" in sw and "finances-pwa-v' + $prev + '" not in sw'))
  $t = [regex]::Replace($t,
    'check\("footer stamp: brand \+ shell v\d+ \+ live date/time, one source for both footers",',
    ('check("footer stamp: brand + shell v' + $maj + ' + live date/time, one source for both footers",'))
  $t = [regex]::Replace($t,
    '"var SHELL_RELEASE = \{ v: \d+" in js',
    ('"var SHELL_RELEASE = { v: ' + $maj + '" in js'))
  if (-not ($t -like "*cache is v$maj (dot releases v$maj.x per subtask)*") -or
      (-not ($t -like "*`"finances-pwa-v$maj`" in sw and `"finances-pwa-v$prev`" not in sw*")) -or
      (-not ($t -like "*shell v$maj + live date/time*")) -or
      (-not ($t -like "*SHELL_RELEASE = { v: $maj`" in js*"))) {
    Bad "could not stamp version assertions in tools\check_site.py"
  }
  Write-Text $p $t
  Write-Host "[stamp] check_site.py asserts v$maj (negative: v$prev)" -ForegroundColor Yellow

  # 5. root mirrors (finances/) - canonical copies from tools/, path fixed
  $mSite = [regex]::Replace((Read-Text (Join-Path $repo "tools\check_site.py")),
    "SITE = os\.path\.dirname\(HERE\)", "SITE = os.path.join(HERE, 'finance-app')")
  if ($mSite -notlike "*SITE = os.path.join(HERE, 'finance-app')*") {
    Bad "SITE line not found in tools\check_site.py (mirror sync)"
  }
  Write-Text (Join-Path $root "check_site.py") $mSite
  Copy-Item (Join-Path $repo "tools\test_chat_parser.py") (Join-Path $root "test_chat_parser.py") -Force
  Write-Host "[sync]  root mirrors (check_site.py SITE line + test_chat_parser.py)" -ForegroundColor Yellow
}

# ------------------------- PREFLIGHT -------------------------
# v73.48: the gate suite's dependencies must ALL exist before any gate runs.
# The v73.42 incident destroyed the (then loose, untracked) smoke harness and
# the failure only surfaced at the END of a 10-gate run as a bare Node error.
# Now a missing file hard-fails at the TOP, naming exactly what's missing.
# The smokes + seed are repo-tracked under tools\smoke (recoverable by
# definition via git checkout); the root mirrors are regenerated by the STAMP
# step above (or -GatesOnly assumes they're already in place).
$preflight = @(
  (Join-Path $repo "app.js"),
  (Join-Path $repo "chat.js"),
  (Join-Path $repo "ai.js"),
  (Join-Path $repo "sw.js"),
  (Join-Path $repo "tools\check_site.py"),
  (Join-Path $repo "tools\test_chat_parser.py"),
  (Join-Path $repo "tools\smoke\smoke_v68.js"),
  (Join-Path $repo "tools\smoke\smoke_app_v68.js"),
  (Join-Path $repo "tools\smoke\smoke_seed.json"),
  (Join-Path $root "check_site.py"),
  (Join-Path $root "test_chat_parser.py")
)
$missing = @($preflight | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "PREFLIGHT FAIL: gate dependencies missing:" -ForegroundColor Red
  foreach ($m in $missing) { Write-Host "   missing: $m" -ForegroundColor Red }
  Write-Host "   (repo files: git checkout origin/main -- <path>; root mirrors: re-run the STAMP step)" -ForegroundColor Yellow
  exit 2
}
Write-Host "[preflight] all gate dependencies present" -ForegroundColor Green

# ------------------------- GATES -------------------------
Set-Location $repo
Gate "gate: python tools\check_site.py (repo)" {
  Set-Location $repo; python tools\check_site.py
}
Gate "gate: python check_site.py (root mirror)" {
  Set-Location $root; python check_site.py
}
Gate "gate: python tools\test_chat_parser.py" {
  Set-Location $repo; python tools\test_chat_parser.py
}
Gate "syntax: node --check app.js chat.js ai.js sw.js" {
  Set-Location $repo
  foreach ($f in @("app.js", "chat.js", "ai.js", "sw.js")) {
    node --check $f
    if ($LASTEXITCODE -ne 0) {
      Write-Host "   node --check $f FAILED" -ForegroundColor Red
      break
    }
  }
}
Gate "smoke: node tools\smoke\smoke_v68.js (real chat.js parser)" {
  Set-Location $repo; node tools\smoke\smoke_v68.js
}
Gate "smoke: node tools\smoke\smoke_app_v68.js (real app.js)" {
  Set-Location $repo; node tools\smoke\smoke_app_v68.js
}

Write-Host ""
if ($script:fail -eq 0) {
  Write-Host "GATES: all green - safe to commit + push" -ForegroundColor Green
  exit 0
}
Write-Host "GATES: RED - fix and re-run; never push past a red gate" -ForegroundColor Red
exit 1
