$ErrorActionPreference = "Stop"

$node = "C:\Users\TRAN THI NHUNG\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $appDir
Write-Host ""
Write-Host "Dang khoi dong HE THONG QUAN LY COM CA..." -ForegroundColor Cyan
Write-Host "Neu thay dong 'Meal shift web running at http://localhost:3000' la da chay thanh cong." -ForegroundColor Yellow
Write-Host "Sau do mo trinh duyet: http://localhost:3000" -ForegroundColor Green
Write-Host "Luu y: giu cua so PowerShell nay mo. Dong cua so nay thi app se dung." -ForegroundColor Yellow
Write-Host ""

& $node server.js
