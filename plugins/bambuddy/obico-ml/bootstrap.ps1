param(
  [string]$DataDir = $env:SOL_PLUGIN_DATA_DIR
)

$ErrorActionPreference = 'Stop'
if (-not $DataDir) { throw 'SOL_PLUGIN_DATA_DIR is required (or pass -DataDir).' }

$pluginDir = $PSScriptRoot
$manifest = Get-Content (Join-Path $pluginDir 'manifest.json') -Raw | ConvertFrom-Json
$root = Join-Path $DataDir 'obico-ml'
$sourceRoot = Join-Path $root 'source'
$mlApi = Join-Path $sourceRoot 'ml_api'
$modelDir = Join-Path $root 'models'
$modelPath = Join-Path $modelDir 'model-weights.onnx'
$venv = Join-Path $root 'venv'
$logDir = Join-Path $root 'logs'
$log = Join-Path $logDir 'bootstrap.log'

New-Item -ItemType Directory -Force -Path $root,$sourceRoot,$modelDir,$logDir | Out-Null
Start-Transcript -Path $log -Append | Out-Null
try {
  Write-Output "Obico ML bootstrap starting"

  function Find-Python {
    $candidates = @(
      (Join-Path $env:APPDATA 'uv\python\cpython-3.11.15-windows-x86_64-none\python.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe')
    )
    foreach ($candidate in $candidates) {
      if (Test-Path $candidate) { return $candidate }
    }
    if (Get-Command py.exe -ErrorAction SilentlyContinue) {
      try {
        $found = (& py.exe -3.11 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1).Trim()
        if ($found -and (Test-Path $found)) { return $found }
      } catch {}
    }
    if (Get-Command python.exe -ErrorAction SilentlyContinue) {
      $found = (& python.exe -c "import sys; print(sys.executable)" | Select-Object -First 1).Trim()
      if ($found -and (Test-Path $found)) { return $found }
    }
    throw 'Python 3.11/3.12 not found. Install Python and rerun bootstrap.'
  }

  $python = Find-Python
  Write-Output "Python: $python"

  if (-not (Test-Path (Join-Path $mlApi 'server.py'))) {
    $tmp = Join-Path $env:TEMP ("obico-src-" + [guid]::NewGuid().ToString('N'))
    $zip = "$tmp.zip"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Write-Output "Downloading Obico source commit $($manifest.upstream.commit)"
    Invoke-WebRequest -UseBasicParsing -Uri $manifest.upstream.archiveUrl -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $expanded = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $expanded) { throw 'Obico archive did not contain a source directory.' }
    if (Test-Path $sourceRoot) { Remove-Item $sourceRoot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
    Copy-Item (Join-Path $expanded.FullName 'ml_api') $sourceRoot -Recurse -Force
    if (Test-Path (Join-Path $expanded.FullName 'LICENSE')) {
      Copy-Item (Join-Path $expanded.FullName 'LICENSE') (Join-Path $sourceRoot 'LICENSE') -Force
    }
    Remove-Item $tmp,$zip -Recurse -Force -ErrorAction SilentlyContinue
  }

  # Windows patch 1: select model from plugin-data.
  $serverPath = Join-Path $mlApi 'server.py'
  $server = Get-Content $serverPath -Raw
  $oldServer = "net_main = load_net(path.join(model_dir, 'model.cfg'), path.join(model_dir, 'model.meta'))"
  $newServer = "net_main = load_net(path.join(model_dir, 'model.cfg'), path.join(model_dir, 'model.meta'), environ.get('ML_MODEL_PATH') or None)"
  if (-not $server.Contains($newServer)) {
    if (-not $server.Contains($oldServer)) { throw 'server.py patch anchor not found' }
    $server = $server.Replace($oldServer, $newServer)
    [IO.File]::WriteAllText($serverPath, $server, (New-Object Text.UTF8Encoding($false)))
  }

  # Windows patch 2: preload CUDA/cuDNN DLLs installed through pip.
  $onnxPath = Join-Path $mlApi 'lib\onnx.py'
  $onnx = Get-Content $onnxPath -Raw
  $providerLine = "        providers = ['CUDAExecutionProvider'] if use_gpu else ['CPUExecutionProvider']"
  $preloadLine = '        if use_gpu and hasattr(onnxruntime, "preload_dlls"):'
  if (-not $onnx.Contains($preloadLine)) {
    if (-not $onnx.Contains($providerLine)) { throw 'onnx.py patch anchor not found' }
    $insert = $preloadLine + [Environment]::NewLine + '            onnxruntime.preload_dlls(directory="")' + [Environment]::NewLine + $providerLine
    $onnx = $onnx.Replace($providerLine, $insert)
    [IO.File]::WriteAllText($onnxPath, $onnx, (New-Object Text.UTF8Encoding($false)))
  }

  $needModel = $true
  if (Test-Path $modelPath) {
    $actual = (Get-FileHash -Algorithm SHA256 $modelPath).Hash.ToLowerInvariant()
    $needModel = $actual -ne [string]$manifest.model.sha256
  }
  if ($needModel) {
    $download = "$modelPath.download"
    Write-Output "Downloading verified Obico ONNX model"
    Invoke-WebRequest -UseBasicParsing -Uri $manifest.model.url -OutFile $download
    $actual = (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant()
    if ($actual -ne [string]$manifest.model.sha256) {
      Remove-Item $download -Force -ErrorAction SilentlyContinue
      throw "Model SHA256 mismatch: $actual"
    }
    Move-Item $download $modelPath -Force
  }

  if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Write-Output "Creating Python virtual environment"
    & $python -m venv $venv
  }

  $venvPython = Join-Path $venv 'Scripts\python.exe'
  & $venvPython -m pip install --upgrade pip
  & $venvPython -m pip install -r (Join-Path $pluginDir 'requirements-win-gpu.txt')

  Copy-Item (Join-Path $pluginDir 'run_server.py') (Join-Path $root 'run_server.py') -Force
  Copy-Item (Join-Path $pluginDir 'launch.ps1') (Join-Path $root 'launch.ps1') -Force

  $providers = & $venvPython -c "import onnxruntime as o; o.preload_dlls(directory=''); print(','.join(o.get_available_providers()))"
  Write-Output "ONNX providers: $providers"

  $state = [ordered]@{
    schemaVersion = 1
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    upstreamCommit = [string]$manifest.upstream.commit
    modelSha256 = [string]$manifest.model.sha256
    providers = [string]$providers
    gpuActive = ([string]$providers).Contains('CUDAExecutionProvider')
    python = $venvPython
  }
  $state | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $root 'runtime-state.json') -Encoding UTF8

  & (Join-Path $root 'launch.ps1')
  Write-Output "Obico ML bootstrap completed"
}
finally {
  Stop-Transcript | Out-Null
}
