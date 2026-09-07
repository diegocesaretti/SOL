param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3000,
  [int]$LauncherPid = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$baseUrl = "http://${HostName}:${Port}"
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true
$notify.Text = "SOL · iniciando"

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
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $format.Dispose(); $white.Dispose(); $font.Dispose(); $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
  return $icon
}

$greenIcon = New-SolIcon ([System.Drawing.Color]::FromArgb(50, 190, 105))
$redIcon = New-SolIcon ([System.Drawing.Color]::FromArgb(220, 75, 75))
$yellowIcon = New-SolIcon ([System.Drawing.Color]::FromArgb(220, 165, 55))
$notify.Icon = $yellowIcon

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
$notify.add_DoubleClick({ Open-Sol "/inputs/plugins/ui" })

$script:failedChecks = 0
$script:shouldExit = $false
$exitItem.add_Click({
  $script:shouldExit = $true
  if ($LauncherPid -gt 0) {
    try { Stop-Process -Id $LauncherPid -Force -ErrorAction Stop } catch {}
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  try {
    $response = Invoke-RestMethod -Uri ($baseUrl + "/health") -Method Get -TimeoutSec 2
    if ($response.ok -eq $true -and $response.database -eq $true) {
      $notify.Icon = $greenIcon
      $notify.Text = "SOL · funcionando"
      $script:failedChecks = 0
    } else {
      $notify.Icon = $redIcon
      $notify.Text = "SOL · error de base de datos"
      $script:failedChecks++
    }
  } catch {
    $notify.Icon = $redIcon
    $notify.Text = "SOL · no responde"
    $script:failedChecks++
  }
  if ($script:shouldExit -or $script:failedChecks -ge 24) {
    $timer.Stop()
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()

$notify.Visible = $false
$notify.Dispose()
$timer.Dispose()
$greenIcon.Dispose(); $redIcon.Dispose(); $yellowIcon.Dispose()
