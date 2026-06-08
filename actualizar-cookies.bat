@echo off
color 0A
title Actualizador de Cookies de Facebook

echo ========================================================
echo        ACTUALIZADOR DE COOKIES DE FACEBOOK
echo ========================================================
echo.
echo 1. Se abrira un bloc de notas vacio.
echo 2. Pega el JSON completo de tus nuevas cookies ahi.
echo 3. Guarda los cambios (Ctrl + G o Archivo -^> Guardar).
echo 4. Cierra el bloc de notas.
echo.
pause

set TEMP_FILE=temp_cookies_input.json
type nul > %TEMP_FILE%

:: Abrir notepad y esperar a que el usuario lo cierre
start /wait notepad %TEMP_FILE%

echo.
echo Procesando cookies...
node scripts\process_cookies.js %TEMP_FILE%

if %errorlevel% neq 0 (
    echo.
    echo ========================================================
    echo ERROR: Hubo un problema al procesar el JSON.
    echo Por favor, vuelve a intentar.
    echo ========================================================
    del %TEMP_FILE%
    pause
    exit /b %errorlevel%
)

:: Limpiar el archivo temporal
del %TEMP_FILE%

echo.
echo ========================================================
echo Subiendo cookies actualizadas al servidor remoto...
echo ========================================================
powershell -ExecutionPolicy Bypass -File deploy.ps1 -IncludeCookies

echo.
echo ========================================================
echo PROCESO COMPLETADO EXITOSAMENTE
echo Las cookies ya estan funcionando en produccion.
echo ========================================================
pause
