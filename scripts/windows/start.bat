@echo off
title Studio Braid - Servidor
cd /d "%~dp0..\.."
echo ========================================================
echo         STUDIO BRAID - EXPORTADOR SCREEN STUDIO
echo ========================================================
echo Interface Web: http://127.0.0.1:3847
echo Pressione Ctrl+C para encerrar o servidor.
echo.
start http://127.0.0.1:3847
node packages/server/dist/index.js
