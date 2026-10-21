param(
    [Parameter(Mandatory = $true)]
    [string]$EvidenceDirectory,
    [ValidateRange(0, 65535)]
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$entryPoint = Join-Path $PSScriptRoot 'local-preview.mjs'
Write-Host 'Local-only synthetic preview. The process prints its PID and loopback URL. Ctrl+C stops it; evidence is preserved.'
& node $entryPoint --evidence-directory $EvidenceDirectory --port $Port
exit $LASTEXITCODE
