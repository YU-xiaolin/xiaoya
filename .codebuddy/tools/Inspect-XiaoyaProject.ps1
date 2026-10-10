[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$SaveTo
)

$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) {
    $candidate = (Get-Item -LiteralPath $PSScriptRoot).FullName
    while ($candidate) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'AGENTS.md')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'data\state\learning-state.json'))) {
            $ProjectRoot = $candidate
            break
        }
        $parent = Split-Path -Parent $candidate
        if (-not $parent -or $parent -eq $candidate) { break }
        $candidate = $parent
    }
    if (-not $ProjectRoot) {
        throw 'Cannot locate the project root. Pass -ProjectRoot explicitly.'
    }
}
$projectRootPath = (Resolve-Path -LiteralPath $ProjectRoot).Path
$statePath = Join-Path $projectRootPath 'data\state\learning-state.json'
$rawDir = Join-Path $projectRootPath 'data\raw\sessions'
$lessonPath = Join-Path $projectRootPath 'data\ai\next-lesson.json'
$updatePath = Join-Path $projectRootPath 'data\ai\state-update.json'
$baselinePath = Join-Path $projectRootPath 'data\ai\parent-baseline.json'
$packagePath = Join-Path $projectRootPath 'app-source\package.json'
$tauriPath = Join-Path $projectRootPath 'app-source\src-tauri\tauri.conf.json'
$exeCandidates = @(Get-ChildItem -LiteralPath $projectRootPath -Filter '*.exe' -File)
if ($exeCandidates.Count -ne 1) {
    throw "Expected exactly one EXE in project root, found $($exeCandidates.Count)."
}
$exePath = $exeCandidates[0].FullName

function Read-Utf8Json([string]$Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-OptionalJson([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        return Read-Utf8Json $Path
    }
    return $null
}

function Get-RawAggregateHash($Files) {
    $lines = foreach ($file in $Files) {
        '{0}:{1}' -f $file.Name, (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    $payload = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($payload)).Replace('-', '')
    }
    finally {
        $algorithm.Dispose()
    }
}

$state = Read-Utf8Json $statePath
$lesson = Get-OptionalJson $lessonPath
$update = Get-OptionalJson $updatePath
$baseline = Get-OptionalJson $baselinePath
$package = Read-Utf8Json $packagePath
$tauri = Read-Utf8Json $tauriPath

$rawFiles = @(Get-ChildItem -LiteralPath $rawDir -Filter '*.json' -File | Sort-Object Name)
$rawIds = @()
$eventCount = 0
$protocolIssues = @()
foreach ($file in $rawFiles) {
    $session = Read-Utf8Json $file.FullName
    $rawIds += [string]$session.sessionId
    $eventCount += @($session.events).Count
    if ($session.protocol -ne 'FAMILY_LEARNING_SESSION_V1') {
        $protocolIssues += "$($file.Name): $($session.protocol)"
    }
}

$appliedSessionIds = @($state.appliedSessionIds | ForEach-Object { [string]$_ })
$unappliedSessionIds = @($rawIds | Where-Object { $_ -notin $appliedSessionIds })

$statusCounts = [ordered]@{}
$needsAssessmentCount = 0
$formalItemCount = 0
foreach ($subjectProperty in $state.items.PSObject.Properties) {
    $subjectCounts = [ordered]@{}
    foreach ($itemProperty in $subjectProperty.Value.PSObject.Properties) {
        $formalItemCount += 1
        $status = [string]$itemProperty.Value.status
        if (-not $subjectCounts.Contains($status)) {
            $subjectCounts[$status] = 0
        }
        $subjectCounts[$status] += 1
        if ([bool]$itemProperty.Value.needsAssessment) {
            $needsAssessmentCount += 1
        }
    }
    $statusCounts[$subjectProperty.Name] = $subjectCounts
}

$exe = Get-Item -LiteralPath $exePath
$result = [ordered]@{
    snapshotAt = (Get-Date).ToString('o')
    projectRoot = $projectRootPath
    versions = [ordered]@{
        package = [string]$package.version
        tauri = [string]$tauri.version
        exeFileVersion = [string]$exe.VersionInfo.FileVersion
        exeProductVersion = [string]$exe.VersionInfo.ProductVersion
    }
    records = [ordered]@{
        rawFileCount = $rawFiles.Count
        rawEventCount = $eventCount
        appliedSessionCount = $appliedSessionIds.Count
        unappliedSessionIds = $unappliedSessionIds
        protocolIssues = $protocolIssues
    }
    formalState = [ordered]@{
        protocol = [string]$state.protocol
        updatedAt = [string]$state.updatedAt
        formalItemCount = $formalItemCount
        needsAssessmentCount = $needsAssessmentCount
        statusCounts = $statusCounts
        appliedUpdateCount = @($state.appliedUpdateIds).Count
        appliedBaselineCount = @($state.appliedBaselineIds).Count
        ignoredEventCount = @($state.ignoredEventIds).Count
    }
    currentAiFiles = [ordered]@{
        lessonId = if ($lesson) { [string]$lesson.lessonId } else { $null }
        lessonTaskCount = if ($lesson) { @($lesson.tasks).Count } else { 0 }
        lessonBasedOnSessionIds = if ($lesson) { @($lesson.basedOnSessionIds) } else { @() }
        updateId = if ($update) { [string]$update.updateId } else { $null }
        updateApplied = if ($update) { [string]$update.updateId -in @($state.appliedUpdateIds) } else { $false }
        baselineId = if ($baseline) { [string]$baseline.baselineId } else { $null }
        baselineApplied = if ($baseline) { [string]$baseline.baselineId -in @($state.appliedBaselineIds) } else { $false }
    }
    protectedHashes = [ordered]@{
        rawAggregateSha256 = Get-RawAggregateHash $rawFiles
        learningStateSha256 = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
        executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
    }
}

$json = $result | ConvertTo-Json -Depth 10
if ($SaveTo) {
    $saveCandidate = if ([IO.Path]::IsPathRooted($SaveTo)) { $SaveTo } else { Join-Path $projectRootPath $SaveTo }
    $savePath = [IO.Path]::GetFullPath($saveCandidate)
    $saveDirectory = Split-Path -Parent $savePath
    if ($saveDirectory -and -not (Test-Path -LiteralPath $saveDirectory)) {
        New-Item -ItemType Directory -Path $saveDirectory -Force | Out-Null
    }
    Set-Content -LiteralPath $savePath -Value $json -Encoding UTF8
}
$json
