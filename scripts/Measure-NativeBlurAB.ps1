# Live, single-machine pilot. Generated theme fixtures are artifacts, not product sources.
# Uses the existing resource CLI; finally restores the original loaded theme and active list.
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [int]$Seconds = 60,
    [int]$Warmup = 15,
    [int]$Pairs = 3,
    [switch]$TraceFirstPair,
    [string]$CliPath = 'slu',
    [string]$SettingsPath = (Join-Path $env:APPDATA 'com.seelen.seelen-ui/settings.json'),
    [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'com.seelen.seelen-ui/logs/Seelen UI.log')
)
$ErrorActionPreference = 'Stop'
$benchCli = $CliPath
$benchSettingsFile = $SettingsPath
$benchLog = $LogPath
$benchRoot = @(Get-CimInstance Win32_Process -Filter "Name='seelen-ui.exe'")
if ($benchRoot.Count -ne 1) { throw 'Expected one Seelen process' }
$benchPid = [int]$benchRoot[0].ProcessId
$benchBeforeSettings = Get-Content -LiteralPath $benchSettingsFile -Raw | ConvertFrom-Json
$benchActive = @($benchBeforeSettings.activeThemes)
if (($benchActive -join ',') -ne '@default/theme,@aurora/glass') { throw 'Unsupported active theme order; no state changed' }
$benchThemes = Invoke-RestMethod 'http://127.0.0.1:37074/resources/themes'
$benchOriginal = @($benchThemes | ForEach-Object { if ($_.id -eq '@aurora/glass') { $_ } })[0]
if (!$benchOriginal -or !$benchOriginal.sharedStyles) { throw 'Expected Aurora with shared styles' }
$benchOriginalPath = $benchOriginal.metadata.path
if (!(Test-Path -LiteralPath $benchOriginalPath)) { throw 'Original theme source unavailable' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$benchFixtures = @{}
$benchCommon = @'
/* Generated benchmark override: identical foreground/material in both arms. */
:root, :root *:not(#slu-bench-reserved) {
  --slu-native-blur: 0 !important;
  --slu-native-blur-amount: 0px !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
:root .ft-bar:not(#slu-bench-a):not(#slu-bench-b) {
  background: rgba(20,24,32,0.25) !important;
}
'@
foreach ($benchMode in @('off','on')) {
    $benchCopy = $benchOriginal | ConvertTo-Json -Depth 40 | ConvertFrom-Json
    $benchCss = $benchCommon
    if ($benchMode -eq 'on') {
        $benchCss += "`n:root .ft-bar:not(#slu-bench-a):not(#slu-bench-b) { --slu-native-blur: 1 !important; --slu-native-blur-amount: 18px !important; }"
    }
    $benchCopy.sharedStyles += "`n$benchCss"
    foreach ($benchProperty in $benchCopy.styles.psobject.Properties) { $benchProperty.Value += "`n$benchCss" }
    $benchFixture = Join-Path $OutputDirectory "fixture-$benchMode.yml"
    $benchCopy | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $benchFixture -Encoding utf8
    $benchFixtures[$benchMode] = $benchFixture
}
$benchWebviews = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")
$benchReport = [ordered]@{
    StartedUtc=[DateTime]::UtcNow.ToString('o'); Executable=$benchRoot[0].ExecutablePath
    Pid=$benchPid; ExecutableSha256=(Get-FileHash -LiteralPath $benchRoot[0].ExecutablePath).Hash
    Commit=(& git rev-parse HEAD); DirtyFiles=@(& git status --porcelain)
    Windows=(Get-CimInstance Win32_OperatingSystem | Select-Object Version,BuildNumber)
    Gpus=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate)
    Cpu=(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfLogicalProcessors)
    HardwareAcceleration=$benchBeforeSettings.hardwareAcceleration
    PerformanceMode=$benchBeforeSettings.performanceMode
    WebviewGpuDisabledObserved=[bool]($benchWebviews.CommandLine -match '--disable-gpu( |$)')
    OriginalActiveThemes=$benchActive; OriginalThemePath=$benchOriginalPath
    Scope='Actual existing Toolbar .ft-bar, 18 CSS px blur, all other native and CSS backdrop blur disabled in both arms. Foreground theme retained. Debug executable. No claim of frame-time or pixel validation.'
    UserAgreedIdle=$true; Trials=@(); Restored=$false
}
$benchChanged = $false
$benchTraceActive = $false
try {
    for ($benchPair=0; $benchPair -lt $Pairs; $benchPair++) {
        # Alternate order to reduce fixed-order thermal/background bias.
        $benchOrder = if ($benchPair % 2 -eq 0) { @('off','on') } else { @('on','off') }
        foreach ($benchMode in $benchOrder) {
            $benchChanged=$true
            $benchStartLog=(Get-Content -LiteralPath $benchLog -Tail 1)
            & $benchCli resource load theme $benchFixtures[$benchMode] | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Theme CLI failed' }
            Start-Sleep -Seconds $Warmup
            if (!(Get-Process -Id $benchPid -ErrorAction SilentlyContinue)) { throw 'Seelen exited' }
            $benchLoaded=Invoke-RestMethod 'http://127.0.0.1:37074/resources/themes'
            $benchLoaded=@($benchLoaded | ForEach-Object { if ($_.id -eq '@aurora/glass') { $_ } })[0]
            if ($benchLoaded.metadata.path -ne $benchFixtures[$benchMode]) { throw 'Fixture was not loaded' }
            $benchTrial=[ordered]@{ Pair=$benchPair; Mode=$benchMode; StartUtc=[DateTime]::UtcNow.ToString('o'); Samples=@(); Trace=$null }
            Write-Output "START pair=$benchPair mode=$benchMode duration=$Seconds"
            if ($TraceFirstPair -and $benchPair -eq 0) {
                $benchWprStatus=& wpr.exe -status 2>&1 | Out-String
                if ($benchWprStatus -match 'not recording') {
                    $benchTraceStart=& wpr.exe -start GPU -filemode 2>&1 | Out-String
                    if ($LASTEXITCODE -eq 0) { $benchTraceActive=$true }
                    else { $benchTrial.Trace=$benchTraceStart.Trim() }
                } else { $benchTrial.Trace='Skipped: existing or unknown WPR session' }
            }
            $benchTimer=[Diagnostics.Stopwatch]::StartNew()
            $benchPrevious=@{}
            while ($benchTimer.Elapsed.TotalSeconds -lt $Seconds) {
                $benchProcessList=@(Get-CimInstance Win32_Process)
                $benchIds=[System.Collections.Generic.HashSet[int]]::new()
                [void]$benchIds.Add($benchPid)
                do {
                    $benchAdded=$false
                    foreach ($benchP in $benchProcessList) {
                        if ($benchIds.Contains([int]$benchP.ParentProcessId) -and $benchIds.Add([int]$benchP.ProcessId)) { $benchAdded=$true }
                    }
                } while ($benchAdded)
                $benchDwm=@($benchProcessList | Where-Object Name -eq 'dwm.exe' | ForEach-Object { [int]$_.ProcessId })
                $benchEngines=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)
                $benchMemory=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory)
                $benchNow=$benchTimer.Elapsed.TotalSeconds
                $benchRows=@()
                foreach ($benchId in @($benchIds)+$benchDwm) {
                    $benchP=Get-Process -Id $benchId -ErrorAction SilentlyContinue
                    if (!$benchP) { continue }
                    $benchCpu=$benchP.TotalProcessorTime.TotalSeconds
                    $benchPercent=$null
                    if ($benchPrevious.ContainsKey($benchId)) {
                        $benchPrev=$benchPrevious[$benchId]
                        $benchPercent=100*($benchCpu-$benchPrev.Cpu)/($benchNow-$benchPrev.Time)/[Environment]::ProcessorCount
                    }
                    $benchPrevious[$benchId]=@{Cpu=$benchCpu;Time=$benchNow}
                    $benchRows += [ordered]@{
                        Pid=$benchId;Name=$benchP.ProcessName
                        Group=$(if ($benchId -in $benchDwm) {'DWM-shared-desktop'} else {'Seelen-tree'})
                        CpuPercentNormalized=$benchPercent;PrivateBytes=$benchP.PrivateMemorySize64
                        Engines=@($benchEngines | Where-Object Name -Like "pid_${benchId}_*" | Select-Object Name,UtilizationPercentage)
                        GpuMemory=@($benchMemory | Where-Object Name -Like "pid_${benchId}_*" | Select-Object Name,DedicatedUsage,SharedUsage)
                    }
                }
                $benchTrial.Samples += [ordered]@{Seconds=$benchNow;Processes=$benchRows}
                Start-Sleep -Milliseconds 1000
            }
            if ($benchTraceActive) {
                $benchTracePath=Join-Path $OutputDirectory "gpu-$benchMode.etl"
                $benchTraceStop=& wpr.exe -stop $benchTracePath 2>&1 | Out-String
                $benchTraceActive=$false
                $benchTrial.Trace=$benchTraceStop.Trim()
            }
            $benchTrial.ActualSeconds=$benchTimer.Elapsed.TotalSeconds
            $benchTrial.LogTail=@(Get-Content -LiteralPath $benchLog -Tail 100 | Select-String 'native_blur|ERROR' | ForEach-Object {$_.Line})
            $benchReport.Trials += $benchTrial
            $benchReport | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'runtime-ab.json') -Encoding utf8
            Write-Output "DONE pair=$benchPair mode=$benchMode samples=$($benchTrial.Samples.Count)"
        }
    }
} finally {
    if ($benchTraceActive) {
        & wpr.exe -stop (Join-Path $OutputDirectory 'gpu-interrupted.etl') | Out-Null
    }
    if ($benchChanged) {
        & $benchCli resource load theme $benchOriginalPath | Out-Null
        Start-Sleep -Seconds 3
        foreach ($benchFixture in $benchFixtures.Values) { & $benchCli resource unload theme $benchFixture | Out-Null }
        $benchAfter=Get-Content -LiteralPath $benchSettingsFile -Raw | ConvertFrom-Json
        $benchLoaded=Invoke-RestMethod 'http://127.0.0.1:37074/resources/themes'
        $benchLoaded=@($benchLoaded | ForEach-Object { if ($_.id -eq '@aurora/glass') { $_ } })[0]
        $benchReport.Restored=(($benchAfter.activeThemes -join ',') -eq ($benchActive -join ',')) -and $benchLoaded.metadata.path -eq $benchOriginalPath
    }
    $benchReport.FinishedUtc=[DateTime]::UtcNow.ToString('o')
    $benchReport | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'runtime-ab.json') -Encoding utf8
    Write-Output "RESTORED=$($benchReport.Restored)"
}
