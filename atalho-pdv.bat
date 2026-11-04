@echo off
rem ============================================================
rem  Abre o PDV no navegador em modo de IMPRESSAO DIRETA.
rem  O cupom sai na impressora padrao do Windows sem perguntar
rem  nada - ideal com a Epson TM-T20 definida como padrao.
rem
rem  Use este atalho no dia a dia da loja, depois de ter ligado
rem  o servidor pelo iniciar.bat (ou com o endereco.txt apontando
rem  para o sistema na internet).
rem ============================================================
title PDV - RVL Material de Construcao

set URL=http://localhost:3000
rem  [1.14] Sistema na internet? Crie ao lado deste arquivo um endereco.txt
rem  com o endereco do Railway (ex.: https://loja-rvl.up.railway.app) e o
rem  PDV abre la, ainda com impressao direta.
if exist "%~dp0endereco.txt" set /p URL=<"%~dp0endereco.txt"
set PERFIL=%LOCALAPPDATA%\pdv-loja-perfil

rem ---- procura o Chrome ----
set NAV=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set NAV=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set NAV=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set NAV=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe

rem ---- se nao achou, tenta o Edge ----
if "%NAV%"=="" (
  if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set NAV=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
  if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set NAV=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
)

if "%NAV%"=="" (
  echo Nao encontrei o Chrome nem o Edge neste computador.
  echo Abrindo no navegador padrao - o cupom vai pedir confirmacao para imprimir.
  start "" %URL%
  timeout /t 4 >nul
  exit /b 0
)

echo ============================================
echo   Abrindo o PDV com impressao direta
echo   Navegador: %NAV%
echo.
echo   O cupom sai direto na impressora PADRAO
echo   do Windows, sem caixa de dialogo.
echo ============================================

start "" "%NAV%" --kiosk-printing --user-data-dir="%PERFIL%" --app=%URL%
timeout /t 3 >nul
