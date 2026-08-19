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
  throw 'DATABASE_URL is not configured. Run pnpm db:setup first.'
}

$psql = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source
if (-not $psql) {
  foreach ($version in @('18','17','16','15')) {
    $candidate = "C:\Program Files\PostgreSQL\$version\bin\psql.exe"
    if (Test-Path $candidate) { $psql = $candidate; break }
  }
}
if (-not $psql) { throw 'psql.exe was not found.' }

$uri = [Uri]$DatabaseUrl
$userInfo = $uri.UserInfo.Split(':', 2)
$user = [Uri]::UnescapeDataString($userInfo[0])
$password = if ($userInfo.Length -gt 1) { [Uri]::UnescapeDataString($userInfo[1]) } else { '' }
$database = $uri.AbsolutePath.TrimStart('/')
$port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }

$previousPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = $password
  & $psql `
    --host=$($uri.Host) `
    --port=$port `
    --username=$user `
    --dbname=$database `
    --no-password `
    --tuples-only `
    --command='SELECT current_database(), current_user, version();'

  if ($LASTEXITCODE -ne 0) {
    throw "Could not connect to SOL PostgreSQL (exit code $LASTEXITCODE)."
  }
}
finally {
  $env:PGPASSWORD = $previousPassword
}

Write-Host 'SOL PostgreSQL is reachable.' -ForegroundColor Green
