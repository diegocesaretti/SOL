param(
  [Parameter(Position=0)][string]$Command = "",
  [Parameter(Position=1)][string]$Value = "",
  [Parameter(Position=2)][string]$Json = "{}"
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:8770"

function Invoke-SolFastHttp {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$Body = "",
    [int]$TimeoutSec = 15
  )

  try {
    if ($Method -eq "GET") {
      $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $Uri -TimeoutSec $TimeoutSec
    } else {
      $response = Invoke-WebRequest -UseBasicParsing -Method $Method -Uri $Uri -ContentType "application/json" -Body $Body -TimeoutSec $TimeoutSec
    }
    Write-Output $response.Content
    return
  }
  catch {
    $response = $_.Exception.Response
    if ($null -ne $response) {
      try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $content = $reader.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($content)) {
          Write-Output $content
          return
        }
      } catch {}
    }
    throw
  }
}

if ([string]::IsNullOrWhiteSpace($Command) -or $Command -eq "help") {
  Invoke-SolFastHttp -Method GET -Uri "$base/help"
  exit
}

if ($Command -eq "tools") {
  Invoke-SolFastHttp -Method GET -Uri "$base/tools"
  exit
}

if ($Command -eq "schema") {
  $encoded = [Uri]::EscapeDataString($Value)
  Invoke-SolFastHttp -Method GET -Uri "$base/schema?tool=$encoded"
  exit
}

if ($Command -eq "call") {
  $argsObj = $Json | ConvertFrom-Json
  $body = @{ tool = $Value; arguments = $argsObj } | ConvertTo-Json -Depth 20 -Compress
  Invoke-SolFastHttp -Method POST -Uri "$base/call" -Body $body -TimeoutSec 130
  exit
}

$quickArgs = @{}
if ($Command -in @("home_find","whatsapp_search","memory_search","context_search")) {
  $quickArgs.query = $Value
}
elseif ($Command -eq "media_play") {
  $quickArgs.query = $Value
  $quickArgs.autoPlay = $true
  if ($Json -and $Json -ne "{}") {
    $opts = $Json | ConvertFrom-Json
    foreach ($p in $opts.PSObject.Properties) {
      $quickArgs[$p.Name] = $p.Value
    }
  }
}
elseif ($Command -eq "youtube_play") {
  $quickArgs.url = $Value
  if ($Json -and $Json -ne "{}") {
    $opts = $Json | ConvertFrom-Json
    foreach ($p in $opts.PSObject.Properties) {
      $quickArgs[$p.Name] = $p.Value
    }
  }
}
elseif ($Command -eq "home_action") {
  $actionJson = if ($Value -and $Value.Trim().StartsWith("{")) { $Value } elseif ($Json -and $Json -ne "{}") { $Json } else { "{}" }
  $quickArgs = $actionJson | ConvertFrom-Json
}
elseif ($Json -and $Json -ne "{}") {
  $quickArgs = $Json | ConvertFrom-Json
}

$bodyObj = @{ command = $Command; arguments = $quickArgs }
if ($Command -in @("home_action","youtube_play")) {
  $bodyObj.confirmedByUser = $true
}
$body = $bodyObj | ConvertTo-Json -Depth 20 -Compress
Invoke-SolFastHttp -Method POST -Uri "$base/quick" -Body $body -TimeoutSec 130
