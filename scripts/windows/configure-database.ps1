$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envExample = Join-Path $repoRoot '.env.example'
$envPath = Join-Path $repoRoot '.env'

Write-Host 'Paste the PostgreSQL DATABASE_URL.'
Write-Host 'Input is hidden and the credential will only be written to the Git-ignored .env file.'
$secureUrl = Read-Host 'DATABASE_URL' -AsSecureString

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
try {
  $databaseUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if (-not $databaseUrl -or ($databaseUrl -notmatch '^postgres(?:ql)?://')) {
  throw 'DATABASE_URL must be a PostgreSQL connection string beginning with postgresql:// or postgres://.'
}

$uri = $null
try { $uri = [Uri]$databaseUrl } catch {}
if (-not $uri -or -not $uri.Host) {
  throw 'DATABASE_URL does not contain a valid PostgreSQL host.'
}

$isLocal = @('127.0.0.1', 'localhost', '::1') -contains $uri.Host.ToLowerInvariant()
if (-not $isLocal -and $databaseUrl -notmatch '(?:\?|&)sslmode=(require|verify-ca|verify-full)(?:&|$)') {
  Write-Warning 'Remote PostgreSQL URL does not explicitly require TLS (sslmode=require/verify-*). Review it before using SOL.'
}

if (-not (Test-Path $envPath)) {
  Copy-Item $envExample $envPath
}

$escaped = $databaseUrl.Replace('"', '\"')
$line = 'DATABASE_URL="' + $escaped + '"'
$envText = Get-Content $envPath -Raw
if ($envText -match '(?m)^DATABASE_URL=.*$') {
  $envText = [regex]::Replace($envText, '(?m)^DATABASE_URL=.*$', { param($match) $line })
} else {
  $envText += "`r`n$line`r`n"
}
Set-Content -Path $envPath -Value $envText -Encoding UTF8

Write-Host ''
Write-Host 'Database connection saved to .env.' -ForegroundColor Green
Write-Host "Host: $($uri.Host)"
Write-Host 'The password was not printed and .env is ignored by Git.'
Write-Host ''
Write-Host 'Next:'
Write-Host '  pnpm db:check'
Write-Host '  pnpm db:migrate'
