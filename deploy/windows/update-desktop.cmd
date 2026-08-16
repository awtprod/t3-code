@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-desktop.ps1" %*
pause
