@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ports = 3000,3001; foreach ($port in $ports) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
exit
