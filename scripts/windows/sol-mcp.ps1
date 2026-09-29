param()

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

if (-not $env:SOL_DATA_DIR) {
  if ($env:LOCALAPPDATA) {
    $env:SOL_DATA_DIR = Join-Path $env:LOCALAPPDATA "SOL"
  } else {
    $env:SOL_DATA_DIR = Join-Path $root ".sol"
  }
}
if (-not $env:SOL_ENV_FILE) {
  $env:SOL_ENV_FILE = Join-Path $env:SOL_DATA_DIR ".env"
}

$hasToken =
  -not [string]::IsNullOrWhiteSpace($env:SOL_MCP_TOKEN) -or
  -not [string]::IsNullOrWhiteSpace($env:SOL_MCP_TOKEN_FILE) -or
  -not [string]::IsNullOrWhiteSpace($env:NEXO_MCP_TOKEN) -or
  -not [string]::IsNullOrWhiteSpace($env:NEXO_MCP_TOKEN_FILE)

if (-not $hasToken) {
  throw "SOL MCP needs SOL_MCP_TOKEN or SOL_MCP_TOKEN_FILE. Create a member-scoped token in SOL > MCP."
}

$portableNode = Join-Path $root "runtime\node.exe"
$portableEntry = Join-Path $root "apps\server\dist\mcp\nexo-stdio.js"

if ((Test-Path $portableNode) -and (Test-Path $portableEntry)) {
  & $portableNode $portableEntry
  exit $LASTEXITCODE
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  throw "Portable SOL runtime was not found and pnpm is not available."
}

Push-Location $root
try {
  & $pnpm.Source mcp
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
