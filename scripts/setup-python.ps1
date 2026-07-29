param(
    [string]$PythonLauncher = "py"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $ProjectRoot ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if ($PythonLauncher -eq "py") {
    & py -3 -m venv $VenvDir
} else {
    & $PythonLauncher -m venv $VenvDir
}

& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $ProjectRoot "python\requirements.txt")

Write-Host "Python environment ready: $VenvDir"
Write-Host "Activate it with: .\.venv\Scripts\Activate.ps1"
