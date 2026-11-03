#!/bin/bash
# ==============================================================
#   URUCHAMIANIE BOTA RICHUP.IO NA macOS (MacBook Air)
# ==============================================================

# Przejście do katalogu skryptu
cd "$(dirname "$0")"

echo "=============================================================="
echo "  RICHUP.IO BOT NOCNY - macOS"
echo "=============================================================="

# Sprawdzenie czy zainstalowany jest Node.js
if ! command -v node &> /dev/null; then
    echo "❌ BŁĄD: Nie znaleziono Node.js!"
    echo "Pobierz i zainstaluj Node.js ze strony: https://nodejs.org/"
    echo "lub zainstaluj przez Homebrew: brew install node"
    exit 1
fi

# Zapobieganie usypianiu Maca podczas pracy bota (caffeinate w tle)
caffeinate -d -i -m -u &
CAFF_PID=$!

cleanup() {
    echo ""
    echo "Zamykanie bota..."
    kill $CAFF_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

echo "✅ Zapobieganie uśpieniu aktywne (caffeinate)."
echo "🚀 Uruchamianie bota..."
echo ""

node bot.js
