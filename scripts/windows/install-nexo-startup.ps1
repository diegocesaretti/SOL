param([switch]$Remove)

$ErrorActionPreference = "Stop"
$taskName = "Nexo Morning Brief Host"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $taskName"
  exit 0
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$argument = "-NoProfile -WindowStyle Hidden -Command `"& '$pnpm' --dir '$repoRoot' start`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Keeps Nexo running so Morning Brief can execute at 08:00 and catch up after startup." -Force | Out-Null
Write-Host "Installed scheduled task: $taskName"
