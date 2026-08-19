param(
  [string]$PostgresHost = '127.0.0.1',
  [int]$PostgresPort = 5432,
  [string]$AdminUser = 'postgres',
  [string]$DatabaseName = 'sol',
  [string]$DatabaseUser = 'sol'
)

$ErrorActionPreference = 'Stop'

function Find-Psql {
  $command = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $roots = @(
    'C:\Program Files\PostgreSQL\18\bin\psql.exe',
    'C:\Program Files\PostgreSQL\17\bin\psql.exe',
    'C:\Program Files\PostgreSQL\16\bin\psql.exe',
    'C:\Program Files\PostgreSQL\15\bin\psql.exe'
  )

  foreach ($candidate in $roots) {
    if (Test-Path $candidate) { return $candidate }
  }

  throw @'
PostgreSQL/psql was not found.
Install a supported PostgreSQL version for Windows first, then rerun:
  pnpm db:setup:windows
The normal PostgreSQL Windows installer is sufficient; Docker, WSL and pgvector are not required.
'@
}

function New-SafePassword {
  $bytes = New-Object byte[] 24
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  }
  finally {
    $rng.Dispose()
  }
  $password = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
  if ($password.Length -lt 28) { $password += 'SolNativePostgres2026' }
  return $password.Substring(0, 28)
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envExample = Join-Path $repoRoot '.env.example'
$envPath = Join-Path $repoRoot '.env'
$psql = Find-Psql
$password = New-SafePassword

Write-Host "Using PostgreSQL client: $psql"
Write-Host "Connecting to PostgreSQL at ${PostgresHost}:$PostgresPort as '$AdminUser'."
Write-Host 'psql may ask for the PostgreSQL administrator password you chose during installation.'

$tempSql = [IO.Path]::GetTempFileName()
try {
  @"
\set ON_ERROR_STOP on
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '$DatabaseUser', :'sol_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DatabaseUser') \gexec
ALTER ROLE $DatabaseUser WITH LOGIN PASSWORD :'sol_password';
SELECT format('CREATE DATABASE %I OWNER %I', '$DatabaseName', '$DatabaseUser')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DatabaseName') \gexec
ALTER DATABASE $DatabaseName OWNER TO $DatabaseUser;
"@ | Set-Content -Path $tempSql -Encoding UTF8

  & $psql `
    --host=$PostgresHost `
    --port=$PostgresPort `
    --username=$AdminUser `
    --dbname=postgres `
    --set="sol_password=$password" `
    --file=$tempSql

  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL setup failed with exit code $LASTEXITCODE"
  }
}
finally {
  Remove-Item $tempSql -ErrorAction SilentlyContinue
}

$databaseUrl = "postgresql://${DatabaseUser}:${password}@${PostgresHost}:${PostgresPort}/${DatabaseName}"

if (-not (Test-Path $envPath)) {
  Copy-Item $envExample $envPath
}

$envText = Get-Content $envPath -Raw
if ($envText -match '(?m)^DATABASE_URL=.*$') {
  $envText = [regex]::Replace($envText, '(?m)^DATABASE_URL=.*$', "DATABASE_URL=$databaseUrl")
} else {
  $envText += "`r`nDATABASE_URL=$databaseUrl`r`n"
}
Set-Content -Path $envPath -Value $envText -Encoding UTF8

Write-Host ''
Write-Host 'Native PostgreSQL setup complete.' -ForegroundColor Green
Write-Host "Database: $DatabaseName"
Write-Host "User:     $DatabaseUser"
Write-Host "Host:     ${PostgresHost}:$PostgresPort"
Write-Host 'DATABASE_URL was written to .env (which is ignored by Git).'
Write-Host ''
Write-Host 'Next:'
Write-Host '  pnpm db:migrate'
Write-Host '  pnpm dev'
