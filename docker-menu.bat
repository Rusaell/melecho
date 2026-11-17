@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker-menu.ps1"
if errorlevel 1 (
    echo.
    pause
)
