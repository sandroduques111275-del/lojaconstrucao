@echo off
title Sistema de Vendas - RVL Material de Construcao
cd /d "%~dp0"

echo ============================================
echo   RVL MATERIAL DE CONSTRUCAO
echo   Sistema de Vendas
echo ============================================
echo.

rem ---- confere se o Node.js esta instalado ----
where node >nul 2>nul
if errorlevel 1 (
  echo  *** O Node.js nao esta instalado neste computador. ***
  echo.
  echo  O sistema precisa dele para funcionar.
  echo.
  echo  1^) Baixe a versao LTS em https://nodejs.org
  echo  2^) Instale clicando em Avancar ate o fim
  echo  3^) Rode este iniciar.bat de novo
  echo.
  echo  Vou abrir o site do Node.js para voce...
  timeout /t 3 >nul
  start "" https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------------------
rem  Confere BIBLIOTECA POR BIBLIOTECA, e nao so se a pasta existe.
rem  Assim, quando o sistema for atualizado e precisar de uma peca
rem  nova, a instalacao roda sozinha em vez de o servidor morrer.
rem ------------------------------------------------------------------
set PRECISA_INSTALAR=
if not exist "node_modules" set PRECISA_INSTALAR=1
if not exist "node_modules\express" set PRECISA_INSTALAR=1
if not exist "node_modules\sql.js" set PRECISA_INSTALAR=1
if not exist "node_modules\fast-xml-parser" set PRECISA_INSTALAR=1
if not exist "node_modules\xlsx" set PRECISA_INSTALAR=1
if not exist "node_modules\node-forge" set PRECISA_INSTALAR=1
if not exist "node_modules\xml-crypto" set PRECISA_INSTALAR=1
if not exist "node_modules\qrcode" set PRECISA_INSTALAR=1

if defined PRECISA_INSTALAR (
  echo  Instalando o que o sistema precisa.
  echo  Demora 1 ou 2 minutos - so acontece quando ha novidade.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  *** Nao consegui instalar. Confira sua internet e tente de novo. ***
    pause
    exit /b 1
  )
  echo.
)

:RODAR
echo ============================================
echo   SISTEMA NO AR
echo.
echo   Endereco:  http://localhost:3000
echo   Usuario:   admin
echo   Senha:     admin
echo.
echo   NAO FECHE ESTA JANELA enquanto estiver usando.
echo   Ela e o servidor. Fechou aqui, o sistema para.
echo ============================================
echo.

start "" http://localhost:3000
node server.js
if not errorlevel 1 goto FIM

rem ---- caiu logo de cara: quase sempre e biblioteca faltando ----
echo.
echo  O servidor nao subiu. Vou reinstalar as bibliotecas e tentar de novo...
echo.
call npm install
echo.
node server.js
if not errorlevel 1 goto FIM

echo.
echo  *** O servidor parou com erro. ***
echo  Tire uma foto desta tela e mande para quem cuida do sistema.

:FIM
echo.
echo  O servidor parou. Feche esta janela ou rode o iniciar.bat de novo.
pause
