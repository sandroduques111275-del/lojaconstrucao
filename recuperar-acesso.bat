@echo off
title Recuperar acesso - RVL Material de Construcao
cd /d "%~dp0"

echo ============================================
echo   RECUPERAR O ACESSO DE ADMINISTRADOR
echo ============================================
echo.
echo  Use este arquivo quando ninguem mais consegue
echo  entrar no sistema: senha esquecida, login trocado
echo  sem querer ou perfil sem acesso.
echo.
echo  O que ele faz:
echo    - devolve o login  admin  com a senha  admin
echo    - devolve o acesso total a esse login
echo.
echo  O que ele NAO faz:
echo    - nao apaga venda, produto, cliente nem nota
echo    - nao mexe nos outros usuarios
echo.
echo  IMPORTANTE: feche antes a janela preta do sistema.
echo.
echo  (Se o sistema estiver NA INTERNET, use a variavel
echo   RESETAR_ADMIN=1 no Railway - veja SUBIR PARA O RAILWAY.txt.)
echo.
pause
echo.
node server.js --resetar-admin
echo.
pause
