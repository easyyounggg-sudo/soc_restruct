@echo off
echo ================================
echo   PDF Parser Backend Service
echo ================================
echo.

REM 检查是否安装了依赖
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo Installing dependencies...
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate.bat
)

echo.
echo Starting server on http://localhost:8000
echo Press Ctrl+C to stop
echo.

python main.py

