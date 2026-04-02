# AI Trading System V2

AI Trading System V2 is a local MT5 + Node.js trading stack that connects a MetaTrader 5 Expert Advisor to a decision server with learning, usage tracking, and simulation workflows.

This repository currently targets intraday `M15` trading for:

- `XAUUSD`
- `EURUSD`

The system is built around a filtered trend-following model with pullback and continuation detection, session-aware routing, conservative risk controls, and a server-side review layer that can run with OpenAI models or local-only fallback logic.

## Components

- `AI_Server_Filtered_XAUUSD.mq5`: MetaTrader 5 Expert Advisor
- `AI_Server_Filtered_XAUUSD.ex5`: compiled EA artifact
- `ai-server/src/server.js`: local decision server
- `ai-server/src/simulate.js`: compatibility simulation runner
- `ai-server/src/backtest_from_csv.js`: CSV backtest runner

## Repository Layout

```text
AI Trading System V2/
|- AI_Server_Filtered_XAUUSD.mq5
|- AI_Server_Filtered_XAUUSD.ex5
|- README.md
`- ai-server/
   |- package.json
   |- .env
   `- src/
      |- server.js
      |- simulate.js
      |- backtest_from_csv.js
      |- trades.json
      |- pending_trades.json
      |- learning_state.json
      |- strategy_notes.json
      |- usage_state.json
      |- simulation_state/
      `- monthly_estimate_state/
```

## How It Works

### EA flow

The MT5 EA:

- reads chart state and indicators
- applies local guards such as spread, ATR, cooldown, session, and position-count checks
- sends a JSON payload to the Node server
- receives `BUY`, `SELL`, or `SKIP`
- executes and manages the trade locally
- reports the final trade result back to the server

Default endpoints used by the EA:

- `GET /health`
- `POST /decision`
- `POST /trade-result`

Typical local URLs:

- `http://127.0.0.1:3000/health`
- `http://127.0.0.1:3000/decision`
- `http://127.0.0.1:3000/trade-result`

### Server flow

The Node server:

- evaluates each setup with local scoring first
- checks learning data for similar setup buckets
- optionally calls a cheaper model or a primary model
- stores pending trade context until the final result arrives
- updates learning statistics after trade close
- tracks estimated model usage and monthly budget consumption
- refreshes strategy notes from recent performance

### Learning model

The learning state is updated from closed trades and grouped by dimensions such as:

- symbol
- timeframe
- session
- trend bias
- setup tag
- confidence bucket
- action and route tier

Weak buckets can be penalized or blocked automatically.

## Current Trading Profile

The repo is currently tuned for `M15` intraday trading with London and New York session focus.

Live defaults described in the existing strategy:

- `XAUUSD`: up to `3` open positions per symbol
- `EURUSD`: up to `1` open position per symbol

The EA contains a dedicated EURUSD profile toggle and different spread / ATR / confidence thresholds for that symbol.

## Requirements

- Windows with MetaTrader 5
- Node.js
- OpenAI API key only if you want live model calls

The server can still run in local-only mode with `ENABLE_MODEL_CALLS=0`.

## Quick Start

### 1. Install server dependencies

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm install
```

### 2. Create `ai-server/.env`

Example:

```env
PORT=3000
API_SECRET=your-shared-secret
OPENAI_API_KEY=your-openai-api-key
PRIMARY_MODEL=gpt-5.4
CHEAP_MODEL=gpt-5.4-mini
ENABLE_MODEL_CALLS=1
SIMULATION_MODE=0
MAX_DAILY_CALLS=20
MONTHLY_BUDGET_USD=30
TRACKED_SYMBOLS=XAUUSD,EURUSD
```

Important notes:

- `API_SECRET` must match on both the EA and the Node server
- keep real secrets out of version control
- set `ENABLE_MODEL_CALLS=0` to force local-only decisions
- `SIMULATION_MODE=1` is intended for simulation workflows, not live trading

## Environment Variables

`server.js` supports these core settings:

- `PORT`: server port, default `3000`
- `API_SECRET`: shared secret checked through `x-api-secret`
- `OPENAI_API_KEY`: required only when model calls are enabled
- `ENABLE_MODEL_CALLS`: `0` disables remote model usage
- `SIMULATION_MODE`: `1` enables simulation behavior
- `DATA_DIR`: override the directory used for JSON state files
- `TRADES_FILE`
- `PENDING_FILE`
- `LEARNING_FILE`
- `STRATEGY_NOTES_FILE`
- `USAGE_STATE_FILE`
- `TRACKED_SYMBOLS`: default `XAUUSD,EURUSD`
- `PRIMARY_MODEL`: default `gpt-5.4`
- `CHEAP_MODEL`: default `gpt-5.4-mini`
- `MAX_DAILY_CALLS`: default `20`
- `MONTHLY_BUDGET_USD`: default `30`
- `BASE_MONTHLY_TARGET_USD`: default `20`
- `ESTIMATED_CHEAP_CALL_USD`
- `ESTIMATED_PRIMARY_CALL_USD`
- `ESTIMATED_SUMMARY_CALL_USD`
- `ESTIMATED_ABNORMAL_CALL_USD`

CSV backtesting also supports:

- `BT_SYMBOL`
- `BT_TIMEFRAME`
- `BT_INITIAL_BALANCE`
- `BT_POINT_SIZE`
- `BT_RISK_PERCENT_FALLBACK`

## Running The Server

Start the API:

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm start
```

The server entry point is `ai-server/src/server.js`.

Available endpoints:

- `GET /health`
- `POST /health`
- `POST /decision`
- `POST /trade-result`
- `GET /learning-status`
- `GET /usage-status`
- `GET /startup-status`
- `GET /strategy-notes`

## MT5 Setup

1. Open `AI_Server_Filtered_XAUUSD.mq5` in MetaEditor and compile it.
2. Confirm the EA inputs point to your local server URLs.
3. Set the same `API_SECRET` in the EA and the Node server.
4. Add the localhost server URL to MT5 WebRequest allowed URLs.
5. Enable Algo Trading.
6. Verify the EA health check succeeds before enabling live execution.

Recommended chart setup from the current project profile:

1. Attach one EA instance to `XAUUSD M15` with `InpSymbol=XAUUSD` and `InpMaxOpenPositionsPerSymbol=3`.
2. Attach one EA instance to `EURUSD M15` with `InpSymbol=EURUSD`, `InpUseEURUSDProfile=true`, and `InpMaxOpenPositionsPerSymbol=1`.

## Simulation

Run the compatibility simulation:

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm run simulate
```

`npm run compat-check` currently runs the same simulation entry point.

The simulation validates the end-to-end loop:

- health checks
- decision requests
- pending trade tracking
- trade result reporting
- learning updates
- strategy note refresh
- usage tracking

Simulation state is stored under `ai-server/src/simulation_state/`.

## CSV Backtesting

Run a backtest from MT5-exported bar data:

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm run backtest:csv -- "C:\path\to\bars.csv"
```

Expected CSV columns:

- `time`
- `open`
- `high`
- `low`
- `close`
- optional `spread`

The CSV backtester:

- computes EMA, RSI, and ATR internally
- derives session from bar time
- detects bias and setup tags
- calls the same local decision API
- simulates SL/TP outcomes
- feeds results back into the learning engine

If `DATA_DIR` is not overridden, CSV backtest state is written to `ai-server/src/csv_backtest_state/`.

## State Files

The server persists JSON state and can also redirect it through `DATA_DIR` or explicit file overrides.

Primary state files:

- `ai-server/src/trades.json`: closed trades history
- `ai-server/src/pending_trades.json`: decision context waiting for outcome feedback
- `ai-server/src/learning_state.json`: learning and bucket statistics
- `ai-server/src/strategy_notes.json`: summarized strategy guidance
- `ai-server/src/usage_state.json`: estimated model usage and budget tracking

Additional state folders:

- `ai-server/src/simulation_state/`
- `ai-server/src/monthly_estimate_state/`

## NPM Scripts

```powershell
npm start
npm run simulate
npm run compat-check
npm run backtest:csv -- "C:\path\to\bars.csv"
```

## Operational Notes

- Start with simulation before connecting the EA to live charts.
- Review `/learning-status`, `/usage-status`, and `/strategy-notes` regularly.
- `XAUUSD` appears to be the primary tuned symbol in this repo.
- `EURUSD` is supported, but its live behavior should still be monitored carefully before increasing risk.
- This project stores runtime state as JSON files, so treat those files as part of the operating environment.
