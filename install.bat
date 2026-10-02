@echo off
title Instalador Studio Braid
cd /d "%~dp0"
echo ========================================================
echo        INSTALADOR STUDIO BRAID (WINDOWS)
echo ========================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Ocorreu um erro durante a instalacao.
    pause
)
