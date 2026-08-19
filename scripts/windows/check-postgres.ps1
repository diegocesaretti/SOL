param(
  [string]$DatabaseUrl = $env:DATABASE_URL
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envPath = Join-Path $repoRoot '.env'

if (-not $DatabaseUrl -and (Test-Path $envPath)) {
  $line = Get-Content $envPath | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if ($line) { $DatabaseUrl = $line.Substring('DATABASE_URL='.Length).Trim() }
}

if (-not $DatabaseUrl) {
  throw 'DATABASE_URL is not configured. Run pnpm db:setup:windows first.'
}

$psql = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source
if (-not $psql) {
  foreach ($version in @('18','17','16','15')) {
    $candidate = "C:\Program Files\PostgreSQL\$version\bin\psql.exe"
    if (Test-Path $candidate) { $psql = $candidate; break }
  }
}
if (-not $psql) { throw 'psql.exe was not found.' }

& $psql $DatabaseUrl --no-password --tuples-only --command='SELECT current_database(), current_user, version();'
if ($LASTEXITCODE -ne 0) {
  throw "Could not connect to SOL PostgreSQL (exit code $LASTEXITCODE)."
}

Write-Host 'SOL PostgreSQL is reachable.' -ForegroundColor Green
