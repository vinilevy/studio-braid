@echo off
title Parar Studio Braid
echo Encerrando Studio Braid (porta 3847)...
set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3847" ^| findstr "LISTENING"') do (
    set FOUND=1
    taskkill /F /PID %%a >nul 2>&1
    echo Processo %%a finalizado.
)
if "%FOUND%"=="0" (
    echo Nenhum processo do Studio Braid rodando na porta 3847.
) else (
    echo Studio Braid encerrado com sucesso.
)
timeout /t 3 >nul
