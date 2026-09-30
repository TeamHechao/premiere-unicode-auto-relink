@echo off
setlocal
chcp 65001 >nul
py -3 -B "%~dp0relink_media.py" --pause %*
