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
  throw "SOL OpenAI bridge needs SOL_MCP_TOKEN or SOL_MCP_TOKEN_FILE. Create a member-scoped token in SOL > MCP."
}
if ([string]::IsNullOrWhiteSpace($env:SOL_OPENAI_GATEWAY_URL)) {
  throw "SOL OpenAI bridge needs SOL_OPENAI_GATEWAY_URL."
}

$portableNode = Join-Path $root "runtime\node.exe"
$portableBridge = Join-Path $root "apps\server\dist\mcp\openai-bridge.js"
$portableMcp = Join-Path $root "apps\server\dist\mcp\nexo-stdio.js"
$portablePreload = Join-Path $root "apps\server\dist\mcp\stdio-preload.js"

if ((Test-Path $portableNode) -and (Test-Path $portableBridge) -and (Test-Path $portableMcp) -and (Test-Path $portablePreload)) {
  $env:SOL_MCP_BRIDGE_STDIO_COMMAND = $portableNode
  $preloadUri = ([System.Uri]$portablePreload).AbsoluteUri
  $env:SOL_MCP_BRIDGE_STDIO_ARGS = ConvertTo-Json -Compress @("--import", $preloadUri, $portableMcp)
  & $portableNode $portableBridge
  exit $LASTEXITCODE
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  throw "Portable SOL runtime was not found and pnpm is not available."
}

$env:SOL_MCP_BRIDGE_STDIO_COMMAND = $pnpm.Source
$env:SOL_MCP_BRIDGE_STDIO_ARGS = ConvertTo-Json -Compress @("--dir", $root, "mcp")

Push-Location $root
try {
  & $pnpm.Source mcp:bridge
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
