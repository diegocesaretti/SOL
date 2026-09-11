param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [switch]$AllowDifferentUpstream,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedUpstream = '4bdef3b6be1186d9aa22acd8b3ec391c22f0e083'
$TargetPath = (Resolve-Path $TargetPath).Path
$OverlayRoot = $PSScriptRoot
$SourceJava = Join-Path $OverlayRoot 'app/src/main/java'
$TargetJava = Join-Path $TargetPath 'app/src/main/java'

function Replace-Exact([string]$Path, [string]$Needle, [string]$Replacement, [string]$Label) {
    $content = [System.IO.File]::ReadAllText($Path)
    if (-not $content.Contains($Needle)) {
        throw "Could not apply $Label: expected upstream text was not found in $Path"
    }
    $updated = $content.Replace($Needle, $Replacement)
    [System.IO.File]::WriteAllText($Path, $updated, [System.Text.UTF8Encoding]::new($false))
}

if (-not (Test-Path (Join-Path $TargetPath '.git'))) {
    throw "TargetPath must be a git checkout of stremio-native/stremio-android"
}

$head = (& git -C $TargetPath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read target git HEAD' }
if ($head -ne $ExpectedUpstream -and -not $AllowDifferentUpstream) {
    throw "Overlay was validated against upstream $ExpectedUpstream, but target is $head. Re-run with -AllowDifferentUpstream only after reviewing the upstream diff."
}

if (-not (Test-Path $SourceJava)) { throw "Overlay source directory missing: $SourceJava" }
Get-ChildItem $SourceJava -Recurse -File | ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($SourceJava, $_.FullName)
    $destination = Join-Path $TargetJava $relative
    New-Item -ItemType Directory -Force (Split-Path $destination -Parent) | Out-Null
    Copy-Item $_.FullName $destination -Force
}

$mainApplication = Join-Path $TargetJava 'com/stremio/mobile/MainApplication.kt'
Replace-Exact $mainApplication `
'import com.stremio.mobile.di.AppContainer' `
"import com.stremio.mobile.di.AppContainer`nimport com.stremio.mobile.remote.SolRemoteServer" `
'MainApplication import'

Replace-Exact $mainApplication `
"    lateinit var container: AppContainer`n        private set`n" `
"    lateinit var container: AppContainer`n        private set`n    lateinit var solRemoteServer: SolRemoteServer`n        private set`n" `
'MainApplication server property'

Replace-Exact $mainApplication `
'        container = AppContainer(this)' `
"        container = AppContainer(this)`n        solRemoteServer = SolRemoteServer(this, container)`n        runCatching { solRemoteServer.start() }`n            .onFailure { Timber.e(it, \"SOL remote control server could not start\") }" `
'MainApplication server startup'

$mainViewModel = Join-Path $TargetJava 'com/stremio/mobile/presentation/viewmodel/MainViewModel.kt'
Replace-Exact $mainViewModel `
'import com.stremio.mobile.presentation.state.*' `
"import com.stremio.mobile.presentation.state.*`nimport com.stremio.mobile.remote.SolRemoteUiBridge" `
'MainViewModel import'

Replace-Exact $mainViewModel `
"    init {`n        observeBoard()" `
"    init {`n        viewModelScope.launch {`n            SolRemoteUiBridge.events.collect { event ->`n                when (event) {`n                    SolRemoteUiBridge.Event.OpenPlayer -> playerOpen.value = true`n                }`n            }`n        }`n`n        observeBoard()" `
'MainViewModel remote player bridge'

$androidSettings = Join-Path $TargetJava 'com/stremio/mobile/presentation/screens/AndroidSettingsScreen.kt'
Replace-Exact $androidSettings `
"        Text(`n            text = \"NETWORK & DATA USAGE\"," `
"        SolRemoteSettingsCard()`n`n        Text(`n            text = \"NETWORK & DATA USAGE\"," `
'Android Settings pairing card'

Write-Host "Stremio SOL overlay applied to $TargetPath"
Write-Host "Upstream base: $head"
Write-Host 'Control API: TCP 8768; pairing must be opened explicitly in Android Settings.'

if (-not $SkipBuild) {
    Push-Location $TargetPath
    try {
        if (Test-Path './gradlew.bat') {
            & ./gradlew.bat :app:compileDebugKotlin --stacktrace
        } else {
            & ./gradlew :app:compileDebugKotlin --stacktrace
        }
        if ($LASTEXITCODE -ne 0) { throw "Gradle Kotlin compile failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
