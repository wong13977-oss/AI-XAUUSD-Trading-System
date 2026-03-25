# AI Trading System V2

AI Trading System V2 is an MT5 + Node.js trading stack for `XAUUSD` intraday execution. It combines:

- an MT5 Expert Advisor (`AI_Server_Filtered_XAUUSD.mq5`)
- a local AI decision server (`ai-server/src/server.js`)
- learning/state files that track historical performance by setup bucket
- simulation and CSV backtest scripts for workflow validation

The current implementation is built around `M15` trend-following pullback trading, with London and New York session focus, conservative risk handling, and a server-side review layer that can use OpenAI models or a local fallback decision engine.

## Project Structure

```text
AI Trading System V2/
|- AI_Server_Filtered_XAUUSD.mq5
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

## Architecture And Workflow

### 1. MT5 EA side

The EA runs on MetaTrader 5 and:

- reads market state from the chart and indicators
- applies basic local filters such as session, spread, ATR, cooldown, and one-position-only
- sends a JSON payload to the AI server `/decision`
- receives `BUY`, `SELL`, or `SKIP`
- opens and manages trades using the returned confidence, SL/TP, and risk values
- reports the final result back to `/trade-result`

Default MT5 endpoints in the EA:

- `http://127.0.0.1:3000/decision`
- `http://127.0.0.1:3000/trade-result`
- `http://127.0.0.1:3000/health`

### 2. AI server side

The Node server:

- scores every setup locally first
- checks historical performance for the same setup bucket
- optionally applies strategy-note adjustments from recent trade history
- decides whether to block locally, allow locally, call the cheap model, escalate to the primary model, or apply abnormal-market review
- stores pending decisions so the final trade result can be matched back to the original setup
- updates learning statistics after each closed trade
- refreshes strategy notes every 10 trades

### 3. Learning loop

Every trade result updates:

- global performance
- bucket-level performance
- route-tier performance
- confidence-bucket performance
- action-level performance

Buckets are grouped by:

- symbol
- timeframe
- trend bias
- setup tag
- session

If a bucket becomes statistically weak, the system reduces confidence or blocks it completely.

## Trading Strategy

This version is designed for a disciplined, trend-following pullback model on `XAUUSD`.

### Core market idea

- trade with the dominant direction only
- prefer pullbacks rather than chasing extended candles
- favor London and New York sessions
- avoid weak volatility, abnormal spread, and overstretched price from EMA20

### Main directional logic

Bullish bias is preferred when:

- price structure is aligned upward
- fast EMA is above slow EMA
- price is above EMA20
- RSI supports a bullish continuation context
- setup tag indicates a bullish pullback

Bearish bias is preferred when:

- price structure is aligned downward
- fast EMA is below slow EMA
- price is below EMA20
- RSI supports a bearish continuation context
- setup tag indicates a bearish pullback

### Local scoring factors

The local score rewards:

- trend and RSI alignment
- matching setup direction (`TREND_PULLBACK_BUY` / `TREND_PULLBACK_SELL`)
- enough ATR / range
- tighter spread
- healthy candle body and range
- reasonable distance to EMA20

The local score is penalized by:

- existing open position
- news block flag
- daily loss lock

### Decision routing

The server uses a layered decision flow:

1. Reject bad historical buckets immediately.
2. Skip very low local scores without any model call.
3. Auto-allow very high local scores without any model call.
4. Use the cheap model for middle-zone setups.
5. Escalate to the primary model when the setup is near tradable threshold or bucket history is weak/unclear.
6. Run abnormal-market review when spread, ATR, candle range, or distance from EMA20 looks extreme.

### Risk profile

The system is intentionally conservative:

- `SKIP` is valid and expected often
- risk percent is typically around `0.30` to `0.45`
- minimum reward-to-risk target is around `1.6`
- stronger setups can push RR toward `1.9` to `2.1`
- abnormal conditions may reduce risk further or block the trade

### Trade management in the EA

The EA currently supports:

- fixed lot or risk-based lot sizing
- ATR and EMA20 trailing
- partial take profit
- move stop to breakeven after partial
- daily max loss guard
- cooldown between entries
- one-position-only mode

## Run Procedure

### Requirements

- Windows with MetaTrader 5
- Node.js
- an OpenAI API key if you want live model calls

The server can also run without live model calls by using its built-in local fallback logic.

### 1. Prepare the server

From the project root:

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm install
```

Create or update `ai-server/.env`.

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
```

Important:

- use the same `API_SECRET` in both the Node server and the MT5 EA
- do not commit real secrets or API keys
- if you want local-only decisions, set `ENABLE_MODEL_CALLS=0`

### 2. Start the server

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm start
```

The main server runs from `ai-server/src/server.js` and exposes:

- `GET /health`
- `POST /health`
- `POST /decision`
- `POST /trade-result`
- `GET /learning-status`
- `GET /usage-status`
- `GET /startup-status`
- `GET /strategy-notes`

### 3. Configure MT5

Open `AI_Server_Filtered_XAUUSD.mq5` in MetaEditor and compile it.

Check these input values:

- `InpServerUrl`
- `InpTradeResultUrl`
- `InpHealthUrl`
- `InpApiSecret`
- `InpSymbol`
- `InpTF`

Recommended current defaults in the EA:

- symbol: `XAUUSD`
- timeframe: `PERIOD_M15`
- minimum confidence: `70`
- minimum ATR points: `130`
- max spread points: `100`
- session filter enabled
- London and New York sessions enabled

In MetaTrader 5:

1. Attach the EA to an `XAUUSD M15` chart.
2. Enable Algo Trading.
3. Add the localhost server URL to MT5 WebRequest allowed URLs.
4. Confirm the server health check passes.
5. Let the EA request decisions only on new bars unless you intentionally change that behavior.

### 4. Live decision cycle

Once running, the cycle is:

1. New bar or trade-check event happens in MT5.
2. EA builds a payload with trend, RSI, ATR, spread, candle stats, session, and setup tag.
3. Server returns a decision with `action`, `confidence`, `sl_points`, `tp_points`, `risk_percent`, `route_tier`, `source`, and `model`.
4. EA opens or skips the trade.
5. When the trade closes, EA posts the result back to `/trade-result`.
6. Server updates learning and possibly refreshes strategy notes.

## Simulation And Backtesting

### Quick compatibility simulation

This validates the end-to-end server workflow without MT5 live execution.

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm run simulate
```

What it checks:

- decision endpoint behavior
- pending trade tracking
- trade-result learning updates
- strategy notes refresh
- learning-block behavior for weak buckets
- usage/budget accounting

`npm run compat-check` currently runs the same simulation flow.

### CSV backtest

You can backtest from historical bar data exported from MT5.

```powershell
cd "C:\Users\xianq\AI Trading System V2\ai-server"
npm run backtest:csv -- "C:\path\to\your\mt5-bars.csv"
```

Expected CSV columns:

- `time`
- `open`
- `high`
- `low`
- `close`
- optional `spread`

The CSV backtest script:

- computes EMA, RSI, and ATR internally
- derives session from hour
- detects trend bias and pullback setups
- calls the same `/decision` endpoint
- simulates SL/TP outcome bar by bar
- posts trade results back into the learning engine
- prints JSON summary metrics such as win rate, profit factor, drawdown, and net PnL

Useful environment overrides for CSV backtesting:

- `BT_SYMBOL`
- `BT_TIMEFRAME`
- `BT_INITIAL_BALANCE`
- `BT_POINT_SIZE`
- `BT_RISK_PERCENT_FALLBACK`

## State Files

The server persists its state in JSON files under `ai-server/src/`.

- `trades.json`: closed trades history
- `pending_trades.json`: open decision context waiting for result feedback
- `learning_state.json`: global and bucket learning stats
- `strategy_notes.json`: summarized guidance generated from recent performance
- `usage_state.json`: estimated model usage and budget tracking

Separate state folders are also used for simulation and monthly estimate workflows.

## Notes And Recommendations

- Keep the EA and server secrets synchronized.
- Start with simulation mode before connecting to a live chart.
- Review `learning-status`, `usage-status`, and `strategy-notes` regularly.
- If performance degrades in a specific bucket, the server may start filtering it aggressively by design.
- The current codebase is specialized for `XAUUSD` and the `M15` intraday workflow, so use caution before applying it to other symbols or timeframes.

## Current NPM Scripts

```powershell
npm start
npm run simulate
npm run compat-check
npm run backtest:csv -- "C:\path\to\bars.csv"
```
