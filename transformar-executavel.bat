@echo off
title pkthegoat clear - Transformar em Executavel
color 0B

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
echo  pkthegoat clear - Transformador de Executavel
echo ========================================================
echo.

echo [1/3] Verificando @yao-pkg/pkg...
where pkg >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [AVISO] @yao-pkg/pkg nao encontrado!
    echo Instalando @yao-pkg/pkg globalmente...
    echo.
    call npm install -g @yao-pkg/pkg
    if %errorlevel% neq 0 (
        echo.
        echo [ERRO] Erro ao instalar @yao-pkg/pkg
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] @yao-pkg/pkg instalado com sucesso!
) else (
    echo [OK] @yao-pkg/pkg ja esta instalado
)

echo.
echo [2/3] Limpando builds anteriores...
if exist dist rmdir /s /q dist 2>nul
if exist dist (
    echo [AVISO] Nao foi possivel limpar a pasta dist
) else (
    echo [OK] Pasta dist limpa
)

echo.
echo [3/3] Gerando executavel...
echo.
echo Aguarde, isso pode levar alguns minutos...
echo.
echo Executando: pkg . --output dist/pkthegoat-clear.exe
echo.

call pkg . --output dist/pkthegoat-clear.exe

if not exist dist\pkthegoat-clear.exe (
    echo.
    echo [ERRO] Executavel nao foi criado!
    echo.
    echo Possiveis solucoes:
    echo - Verifique se todas as dependencias estao instaladas
    echo - Execute: npm install
    echo - Tente rodar: npm run build
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  [OK] Executavel gerado com sucesso!
echo ========================================================
echo.
echo Localizacao: dist\pkthegoat-clear.exe
echo.

for %%A in (dist\pkthegoat-clear.exe) do set sizeMB=%%~zA
set /a sizeMB=%sizeMB%/1024/1024
echo Tamanho: %sizeMB% MB
echo.

pause
