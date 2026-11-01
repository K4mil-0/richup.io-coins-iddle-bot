# 🎲 Richup.io Overnight Bot (Host + 2 Guest Bots)

Automatyczny bot do **richup.io**, który uruchamia i synchronizuje 3 osobne okna przeglądarki (Google Chrome / Microsoft Edge) za pomocą natywnego protokołu **Chrome DevTools Protocol (CDP)** – bez zewnętrznych bibliotek (`puppeteer` / `selenium`), dzięki czemu przeglądarka jest niewykrywalna dla Cloudflare oraz logowania Google/Discord.

## ✨ Jak to działa?

1. **Okno 1 (`HOST` – Główne konto):**
   - Zapisuje sesję logowania w lokalnym katalogu `profiles/host` (wykluczonym w `.gitignore`).
   - Tworzy prywatny pokój (**Create a private game**) i wchodzi do niego jako pierwszy (100% gwarancji korony `👑 Host`).
   - Ustawia maksymalną startową gotówkę (**Starting cash**) i wyłącza aukcje (**Auction**).
   - Nigdy się nie poddaje i zawsze wygrywa grę, zgarniając monety na konto (HUD zlicza na żywo powiadomienia *"You just earned 1 Coin"*).
2. **Okno 2 (`BOT 1` – Gość 1):**
   - Dołącza do pokoju Hosta z linku, wybiera wolny kolor pionka, rzuca kostką i kupuje pola (bez budowania domków/hoteli).
   - Po **35 rundach** automatycznie ogłasza bankructwo (**Bankrupt**).
3. **Okno 3 (`BOT 2` – Gość 2):**
   - Dołącza do pokoju Hosta z linku, wybiera wolny kolor pionka, rzuca kostką i kupuje pola (bez budowania domków/hoteli).
   - Po **45 rundach** automatycznie ogłasza bankructwo (**Bankrupt**).
4. **Tryb nocny (pętla nieskończona):**
   - Po poddaniu się obu botów-gości główne konto wygrywa mecz, odbiera monety i po 8 sekundach zakłada kolejny pokój.
   - Nie przejmuje fizycznego kursora myszy ani klawiatury w systemie Windows (można normalnie grać w inne gry na drugim monitorze).

## 🚀 Uruchomienie

1. Upewnij się, że masz zainstalowany **Google Chrome** (lub Microsoft Edge) oraz **Node.js (v22+)**.
2. Uruchom plik **`start-bot.bat`** (lub `node bot.js`).
3. Przy pierwszym uruchomieniu kliknij **`⏸️ Pauza`** w lewym górnym rogu pierwszego okna (`HOST`), zaloguj się na swoje konto **richup.io**, a następnie kliknij **`▶️ Wznów bota`**.

## 🔒 Bezpieczeństwo

Katalog `profiles/` (zawierający dane logowania i ciasteczka Twojego konta) jest automatycznie ignorowany przez plik `.gitignore` i nigdy nie zostanie wysłany na GitHuba.
