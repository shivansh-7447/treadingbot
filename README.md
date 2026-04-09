# AI Crypto Trading Bot

Professional modular crypto trading bot for Windows 11 with:

- Node.js bot engine
- Python AI prediction helper
- Express dashboard on `http://localhost:3000`
- Binance and CoinDCX spot support through `ccxt`
- Manual approval before every trade
- Safe-mode risk controls
- Telegram alerts
- Historical backtesting

## Safe Defaults

Your requested spec had two conflicting limits:

- trade size `10%` vs safety requirement `max 5%`
- max trades per day `4` vs risk rule `max 3`

This project enforces the stricter safe-mode defaults:

- trade size: `5%`
- max trades per day: `3`

These are defined in `config.js`.

## Project Structure

```text
crypto-ai-bot/
|-- bot.js
|-- config.js
|-- binance.js
|-- coindcx.js
|-- manual.js
|-- auth.js
|-- db.js
|-- package.json
|-- requirements.txt
|-- README.md
|-- .env
|-- ai/
|   |-- scanner.js
|   |-- ranking.js
|   |-- sentiment.js
|   |-- whale.js
|   |-- portfolio.js
|   |-- predict.py
|   |-- stoploss.js
|   |-- backtestLearning.js
|-- dashboard/
|   |-- server.js
|   |-- index.html
|-- data/
|   |-- bot.db
|   |-- trades.json
|-- tests/
|   |-- execution.test.js
|   |-- manual.integration.test.js
```

## Requirements

- Windows 11
- Node.js `v18+`
- Python `3.10+`
- Internet connection for exchange data and sentiment feeds

## Installation

1. Open PowerShell in the project folder.
2. Install Node dependencies:

```powershell
npm install
```

3. Confirm Python is installed:

```powershell
py --version
```

4. Update `.env` with your API credentials.

## Environment Setup

Edit `.env`:

```env
PORT=3000
PYTHON_BIN=py

BINANCE_API_KEY=your_binance_api_key
BINANCE_SECRET=your_binance_secret
BINANCE_SANDBOX=true

COINDCX_API_KEY=your_coindcx_api_key
COINDCX_SECRET=your_coindcx_secret
COINDCX_SANDBOX=false

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

DASHBOARD_AUTH_ENABLED=true
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-me-now
SESSION_SECRET=change-this-long-random-secret

SQLITE_PATH=./data/bot.db
WEBSOCKET_ENABLED=true
WS_BROADCAST_INTERVAL_MS=5000
```

Dashboard login is enabled by default.
If you do not set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`, the app uses:

- username: `admin`
- password: `change-me-now`

Change these before exposing the dashboard beyond your local machine.

## Exchange API Connection Instructions

### Binance

1. Log in to Binance.
2. Go to API Management.
3. Create a new API key.
4. Enable `Spot & Margin Trading` only if required for spot orders.
5. Do **not** enable withdrawals.
6. Prefer IP restriction if possible.
7. For testing, keep `BINANCE_SANDBOX=true`.

### CoinDCX

1. Log in to CoinDCX.
2. Open API settings.
3. Create a new API key.
4. Allow trading permissions only.
5. Do **not** enable withdrawal permissions.
6. Add the API key and secret into `.env`.

## Telegram Setup

1. Create a Telegram bot using `@BotFather`.
2. Copy the bot token into `TELEGRAM_BOT_TOKEN`.
3. Start a chat with your bot.
4. Get your chat ID.
5. Put it into `TELEGRAM_CHAT_ID`.

The bot sends alerts for:

- new signals
- executed trades
- profit exits
- stop-loss exits

## Running The Project

### Start the dashboard

```powershell
npm start
```

Then open:

[http://localhost:3000](http://localhost:3000)

### Start the bot only

```powershell
npm run bot
```

### Smoke check modules

```powershell
npm run check
```

## How It Works

Bot flow:

1. Market scanner fetches spot market data.
2. Coin ranking scores candidates.
3. Whale detection checks abnormal volume spikes.
4. Sentiment analysis combines Fear & Greed plus news keywords.
5. Python model predicts short-term move probability.
6. Signal enters manual approval queue.
7. Approved trade is executed.
8. Stop-loss and take-profit are managed automatically.
9. Profit, approvals, and metrics are persisted in `SQLite` at `data/bot.db`.

## Dashboard Features

- Start/stop bot
- Manual scan
- Profit tracking
- Trade history
- Risk settings view
- Portfolio allocation view
- Pending approval queue
- Real-time market scanner
- WebSocket-powered live market stream
- Dashboard login and logout
- Backtesting trigger
- Richer intelligence snapshot with news, trending tokens, and network context
- Fee and slippage-aware paper execution

## Testing

Run the test suite:

```powershell
npm test
```

Current coverage includes:

- execution fee/slippage estimation
- SQLite-backed approval lifecycle persistence

## Important Notes

- This project is configured for spot trading only.
- It runs in dry-run behavior if API keys are missing.
- Manual approval is required before execution.
- This is a starter production-style architecture, not a guaranteed profitable strategy.
- Always test in sandbox or with very small capital first.

## Implemented Upgrades

- Authenticated dashboard login with session cookies
- SQLite-backed state persistence with legacy JSON migration
- WebSocket price streaming for live scanner updates
- Richer intelligence feeds using multiple news and market context sources
- Per-exchange fee handling and slippage estimation for paper execution
- Unit and integration tests using Node's built-in test runner
"# treadingbot" 
