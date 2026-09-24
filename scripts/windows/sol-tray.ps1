param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3000,
  [int]$LauncherPid = 0,
  [string]$DataDir = ""
)

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $env:LOCALAPPDATA "SOL"
}
$logDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$logPath = Join-Path $logDir "tray.log"

function Write-TrayLog([string]$message) {
  try {
    Add-Content -Path $logPath -Value ("[{0}] {1}" -f [DateTimeOffset]::Now.ToString("o"), $message) -Encoding UTF8
  } catch {}
}

Write-TrayLog "Tray starting. Host=$HostName Port=$Port LauncherPid=$LauncherPid"

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-TrayLog ("Failed to load WinForms assemblies: " + $_.Exception.Message)
  throw
}

$baseUrl = "http://${HostName}:${Port}"

function New-SolIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 2, 2, 28, 28)
  $font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString("S", $font, $white, [System.Drawing.RectangleF]::new(2,1,28,28), $format)
  $rawIcon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $icon = $rawIcon.Clone()
  $rawIcon.Dispose()
  $format.Dispose(); $white.Dispose(); $font.Dispose(); $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
  return $icon
}

$greenIcon = New-SolIcon ([System.Drawing.Color]::FromArgb(50, 190, 105))
$redIcon = New-SolIcon ([System.Drawing.Color]::FromArgb(220, 75, 75))
$yellowIcon = New-SolIcon ([System.Drawing.Color]::FromArgb(220, 165, 55))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $yellowIcon
$notify.Text = "SOL · iniciando"
$notify.Visible = $true
Write-TrayLog "NotifyIcon visible"

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openInputs = $menu.Items.Add("Abrir Inputs")
$openServices = $menu.Items.Add("Abrir Servicios")
$openHome = $menu.Items.Add("Abrir SOL")
$openLife = $menu.Items.Add("Abrir Life")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add($(if ($LauncherPid -gt 0) { "Cerrar SOL" } else { "Cerrar icono" }))
$notify.ContextMenuStrip = $menu

function Open-Sol([string]$path) {
  try { Start-Process ($baseUrl + $path) | Out-Null } catch {}
}
$openInputs.add_Click({ Open-Sol "/inputs" })
$openServices.add_Click({ Open-Sol "/inputs/plugins/ui" })
$openHome.add_Click({ Open-Sol "/" })
$openLife.add_Click({ Open-Sol "/life" })
$notify.add_DoubleClick({ Open-Sol "/" })

$script:shouldExit = $false
$script:lastStatus = ""
$exitItem.add_Click({
  $script:shouldExit = $true
  if ($LauncherPid -gt 0) {
    try { Stop-Process -Id $LauncherPid -Force -ErrorAction Stop } catch {}
  }
})

function Set-TrayStatus([string]$status, [System.Drawing.Icon]$icon, [string]$text) {
  $notify.Icon = $icon
  $notify.Text = $text
  if ($script:lastStatus -ne $status) {
    Write-TrayLog ("Status=" + $status)
    $script:lastStatus = $status
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if ($LauncherPid -gt 0) {
    try {
      Get-Process -Id $LauncherPid -ErrorAction Stop | Out-Null
    } catch {
      Write-TrayLog "Launcher exited; closing tray"
      $script:shouldExit = $true
    }
  }

  if (-not $script:shouldExit) {
    try {
      $response = Invoke-RestMethod -Uri ($baseUrl + "/health") -Method Get -TimeoutSec 2
      if ($response.ok -eq $true -and $response.database -eq $true) {
        if ($response.databaseMode -eq "hybrid" -and $response.cloudSync.seeded -eq $false) {
          Set-TrayStatus "local-awaiting-cloud" $yellowIcon "SOL · local · esperando Neon"
        } elseif ($response.databaseMode -eq "hybrid" -and $response.cloudDatabase -eq $false) {
          Set-TrayStatus "local-cloud-offline" $yellowIcon "SOL · funcionando · Neon offline"
        } else {
          Set-TrayStatus "healthy" $greenIcon "SOL · funcionando"
        }
      } else {
        Set-TrayStatus "database-error" $redIcon "SOL · error de base de datos"
      }
    } catch {
      Set-TrayStatus "unreachable" $redIcon "SOL · no responde"
    }
  }

  if ($script:shouldExit) {
    $timer.Stop()
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $notify.Visible = $false
  $notify.Dispose()
  $timer.Dispose()
  $greenIcon.Dispose(); $redIcon.Dispose(); $yellowIcon.Dispose()
  Write-TrayLog "Tray stopped"
}
