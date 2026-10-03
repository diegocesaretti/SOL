$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root 'venv\Scripts\python.exe'
$server = Join-Path $root 'run_server.py'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3333 -State Listen -ErrorAction SilentlyContinue
if ($listener) { Write-Output ("ALREADY_RUNNING PID=" + $listener.OwningProcess); exit 0 }
$stdout = Join-Path $logDir 'obico-ml.out.log'
$stderr = Join-Path $logDir 'obico-ml.err.log'
$p = Start-Process -FilePath $py -ArgumentList @($server) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$p.Id | Set-Content -Path (Join-Path $root 'obico-ml.pid') -Encoding ASCII
Write-Output ("STARTED PID=" + $p.Id)
