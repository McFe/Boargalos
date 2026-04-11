@echo off
setlocal

taskkill /f /t /fi "windowtitle eq boargalos"

if not defined IS_MINIMIZED (
  set IS_MINIMIZED=1
  start "boargalos" /min "%~dpnx0" %*
  exit /b
)

cd /d "%~dp0"
node "%~dp0index.js"
exit /b
