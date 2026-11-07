@echo off
title pkthegoat clear LOCAL - Transformar em Executavel
color 0A

REM Verifica se Node.js esta instalado
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Node.js nao esta instalado!
    echo Baixe em: https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM Verifica se node_modules existe
if not exist node_modules (
    echo.
    echo [ERRO] Dependencias nao instaladas!
    echo Execute: npm install
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  pkthegoat clear LOCAL - Executavel sem login
echo ========================================================
echo.
echo Esta build abre o painel direto no navegador, sem tela de
echo login e sem Supabase. Os dados ficam na pasta "data" ao
echo lado do executavel. Use so no seu PC.
echo.

echo [1/3] Verificando @yao-pkg/pkg...
where pkg >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [AVISO] @yao-pkg/pkg nao encontrado! Instalando globalmente...
    echo.
    call npm install -g --allow-scripts=esbuild @yao-pkg/pkg
    where pkg >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo [ERRO] Erro ao instalar @yao-pkg/pkg
        echo.
        pause
        exit /b 1
    )
    echo [OK] @yao-pkg/pkg instalado com sucesso!
) else (
    echo [OK] @yao-pkg/pkg ja esta instalado
)

echo.
echo [2/3] Limpando build local anterior...
if exist dist\pkthegoat-clear-local.exe del /q dist\pkthegoat-clear-local.exe 2>nul

echo.
echo [3/3] Gerando executavel local...
echo.
echo Aguarde, isso pode levar alguns minutos...
echo.
echo Executando: pkg local.js --config package.json --targets node22-win-x64 --output dist/pkthegoat-clear-local.exe
echo.

call pkg local.js --config package.json --targets node22-win-x64 --output dist/pkthegoat-clear-local.exe

if not exist dist\pkthegoat-clear-local.exe (
    echo.
    echo [ERRO] Executavel nao foi criado!
    echo - Verifique se as dependencias estao instaladas: npm install
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  [OK] Executavel LOCAL gerado com sucesso!
echo ========================================================
echo.
echo Localizacao: dist\pkthegoat-clear-local.exe
echo.
echo Basta dar duplo clique. O painel abre no navegador sem login.
echo.

for %%A in (dist\pkthegoat-clear-local.exe) do set sizeMB=%%~zA
set /a sizeMB=%sizeMB%/1024/1024
echo Tamanho: %sizeMB% MB
echo.

pause
