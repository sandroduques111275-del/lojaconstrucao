@echo off
title Deploy - Sistema Loja de Material de Construcao
cd /d "%~dp0"

echo ============================================
echo   DEPLOY - LOJA DE MATERIAL DE CONSTRUCAO
echo ============================================
echo.

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  echo.
)

if not exist .git (
  echo Repositorio git nao encontrado nesta pasta.
  echo Rode uma vez:
  echo    git init
  echo    git remote add origin URL_DO_SEU_REPOSITORIO
  echo.
  pause
  exit /b 1
)

echo Enviando alteracoes...
git add -A
set /p MSG=Mensagem do commit (enter para "atualizacao"):
if "%MSG%"=="" set MSG=atualizacao
git commit -m "%MSG%"
git push

echo.
echo ============================================
echo   DEPLOY ENVIADO
echo   O Railway vai reconstruir sozinho.
echo   Depois de subir, de CTRL+SHIFT+R no navegador.
echo ============================================
pause
