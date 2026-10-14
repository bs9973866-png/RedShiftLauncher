@echo off
chcp 65001 >nul
title Redshift Launcher - сборка установщика
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите LTS с https://nodejs.org и запустите файл снова.
  pause & exit /b 1
)
echo [1/2] Установка зависимостей...
call npm install
if errorlevel 1 ( echo Ошибка npm install & pause & exit /b 1 )
echo [2/2] Сборка установщика .exe...
call npm run dist
if errorlevel 1 ( echo Ошибка сборки & pause & exit /b 1 )
echo.
echo Готово! Установщик лежит в папке dist\RedshiftLauncher-Setup-1.0.0.exe
explorer dist
pause
