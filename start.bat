@echo off
title ShapeForge Dev Server
cd /d "%~dp0"
echo Starting ShapeForge development server at http://localhost:5173/ ...
npm run dev
pause
