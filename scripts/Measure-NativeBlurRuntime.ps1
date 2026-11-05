# Read-only system telemetry. Does NOT switch themes, GPU mode, or restart Seelen.
# DWM/engine numbers include unrelated desktop work; do not treat them as blur-only GPU time.
param(
    [ValidateRange(5, 3600)][int]$Seconds = 60,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$taskRoots = @(Get-CimInstance Win32_Process -Filter "Name='seelen-ui.exe'")
if ($taskRoots.Count -ne 1) { throw 'Expected exactly one Seelen process; identify the intended version first.' }
$taskRootId = [int]$taskRoots[0].ProcessId
$taskSamples = [System.Collections.Generic.List[object]]::new()
$taskLogicalCpus = [Environment]::ProcessorCount
$taskPrevious = @{}
$taskStart = [Diagnostics.Stopwatch]::StartNew()
$taskGpuAvailable = $true
for ($taskIndex = 0; $taskStart.Elapsed.TotalSeconds -lt $Seconds; $taskIndex++) {
    $taskProcesses = @(Get-CimInstance Win32_Process)
    $taskMetadata = @{}
    foreach ($taskInfo in $taskProcesses) { $taskMetadata[[int]$taskInfo.ProcessId] = $taskInfo }
    $taskIds = [System.Collections.Generic.HashSet[int]]::new()
    [void]$taskIds.Add($taskRootId)
    do {
        $taskAdded = $false
        foreach ($taskProcess in $taskProcesses) {
            if ($taskIds.Contains([int]$taskProcess.ParentProcessId) -and $taskIds.Add([int]$taskProcess.ProcessId)) { $taskAdded = $true }
        }
    } while ($taskAdded)
    $taskDwmIds = @($taskProcesses | Where-Object Name -eq 'dwm.exe' | ForEach-Object { [int]$_.ProcessId })
    $taskGpu = @()
    if ($taskGpuAvailable) {
        try { $taskGpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine) }
        catch { $taskGpuAvailable = $false }
    }
    $taskNow = $taskStart.Elapsed.TotalSeconds
    foreach ($taskId in @($taskIds) + $taskDwmIds) {
        $taskProcess = Get-Process -Id $taskId -ErrorAction SilentlyContinue
        if (!$taskProcess) { continue }
        $taskCpu = $taskProcess.TotalProcessorTime.TotalSeconds
        $taskCpuPercent = $null
        $taskPreviousSample = $taskPrevious[$taskId]
        if ($taskPreviousSample -and $taskNow -gt $taskPreviousSample.Time) {
            $taskCpuPercent = 100 * ($taskCpu - $taskPreviousSample.Cpu) / ($taskNow - $taskPreviousSample.Time) / $taskLogicalCpus
        }
        $taskPrevious[$taskId] = @{ Cpu = $taskCpu; Time = $taskNow }
        $taskRole = 'host'
        if ($taskMetadata[$taskId].CommandLine -match '--type=([^ ]+)') { $taskRole = $Matches[1] }
        $taskEngine = @($taskGpu | Where-Object { $_.Name -match "^pid_${taskId}_" } |
            ForEach-Object { @{ Name = $_.Name; Percent = $_.UtilizationPercentage } })
        $taskSamples.Add([ordered]@{
            Seconds = $taskNow; Pid = $taskId; Name = $taskProcess.ProcessName
            Role = $taskRole
            Group = $(if ($taskId -in $taskDwmIds) { 'DWM-shared-desktop' } else { 'Seelen-tree' })
            CpuPercentNormalized = $taskCpuPercent
            PrivateBytes = $taskProcess.PrivateMemorySize64; WorkingSetBytes = $taskProcess.WorkingSet64
            GpuEngines = $taskEngine
        })
    }
    if ($taskStart.Elapsed.TotalSeconds -lt $Seconds) { Start-Sleep -Milliseconds 1000 }
}
$taskReport = [ordered]@{
    Timestamp = [DateTime]::UtcNow.ToString('o'); Executable = $taskRoots[0].ExecutablePath
    Pid = $taskRootId; RequestedSeconds = $Seconds; SampleRounds = $taskIndex; ActualSeconds = $taskStart.Elapsed.TotalSeconds
    GpuCountersAvailable = $taskGpuAvailable
    Note = 'Uncontrolled runtime context only; DWM includes other applications. Seelen memory-pressure simulation runs every 30s. No blur attribution or GPU A/B claim.'
    Samples = $taskSamples
}
$taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output "Saved $($taskSamples.Count) process samples; GPU counters available: $taskGpuAvailable"
