[CmdletBinding()]
param(
    [switch]$AuditOnly,
    [string]$DataDir,
    [string]$PythonPath
)

$ErrorActionPreference = 'Stop'
$candidate = (Get-Item -LiteralPath $PSScriptRoot).FullName
$projectRoot = $null
while ($candidate) {
    if ((Test-Path -LiteralPath (Join-Path $candidate 'AGENTS.md')) -and
        (Test-Path -LiteralPath (Join-Path $candidate 'app-source\package.json'))) {
        $projectRoot = $candidate
        break
    }
    $parent = Split-Path -Parent $candidate
    if (-not $parent -or $parent -eq $candidate) { break }
    $candidate = $parent
}
if (-not $projectRoot) {
    throw 'Cannot locate the project root.'
}
$appSource = Join-Path $projectRoot 'app-source'
$voiceHelper = Join-Path $PSScriptRoot 'edge_tts_voice.py'

if (-not (Test-Path -LiteralPath $voiceHelper)) {
    throw "项目内 Edge-TTS 辅助脚本不存在：$voiceHelper"
}

if (-not $PythonPath) {
    $pythonCommand = Get-Command python.exe -ErrorAction Stop
    $PythonPath = $pythonCommand.Source
}

$oldSkillScript = $env:EDGE_TTS_SKILL_SCRIPT
$oldPython = $env:EDGE_TTS_PYTHON
$oldPythonUtf8 = $env:PYTHONUTF8
$oldDataDir = $env:FAMILY_LEARNING_DATA_DIR

try {
    $env:EDGE_TTS_SKILL_SCRIPT = $voiceHelper
    $env:EDGE_TTS_PYTHON = $PythonPath
    $env:PYTHONUTF8 = '1'
    if ($DataDir) {
        $dataCandidate = if ([IO.Path]::IsPathRooted($DataDir)) { $DataDir } else { Join-Path $projectRoot $DataDir }
        $env:FAMILY_LEARNING_DATA_DIR = [IO.Path]::GetFullPath($dataCandidate)
    }

    Push-Location $appSource
    try {
        if ($AuditOnly) {
            & npm.cmd run voice-pack:audit
            if ($LASTEXITCODE -ne 0) { throw "语音覆盖审计失败，退出码 $LASTEXITCODE" }
        }
        else {
            & npm.cmd run voice-pack
            if ($LASTEXITCODE -ne 0) { throw "语音生成失败，退出码 $LASTEXITCODE" }
            & npm.cmd run voice-pack:audit
            if ($LASTEXITCODE -ne 0) { throw "语音生成完成，但覆盖审计失败，退出码 $LASTEXITCODE" }
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:EDGE_TTS_SKILL_SCRIPT = $oldSkillScript
    $env:EDGE_TTS_PYTHON = $oldPython
    $env:PYTHONUTF8 = $oldPythonUtf8
    $env:FAMILY_LEARNING_DATA_DIR = $oldDataDir
}
