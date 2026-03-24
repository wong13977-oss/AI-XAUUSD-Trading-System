import fs from "fs-extra";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const csvPath = process.argv[2];
const port = Number(process.env.PORT || 3103);
const apiSecret = process.env.API_SECRET || "csv-backtest-secret";
const symbol = process.env.BT_SYMBOL || "XAUUSD";
const timeframe = process.env.BT_TIMEFRAME || "PERIOD_M15";
const initialBalance = Number(process.env.BT_INITIAL_BALANCE || 10000);
const pointSize = Number(process.env.BT_POINT_SIZE || 0.01);
const riskPercentFallback = Number(process.env.BT_RISK_PERCENT_FALLBACK || 0.35);
const simDataDir = process.env.DATA_DIR || path.join(__dirname, "csv_backtest_state");

function usageAndExit() {
  console.log(
    "Usage: npm.cmd run backtest:csv -- <path-to-mt5-bars.csv>\n" +
      "Expected columns include: time/open/high/low/close and optionally spread.",
  );
  process.exit(1);
}

if (!csvPath) {
  usageAndExit();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ema(prev, value, period) {
  const k = 2 / (period + 1);
  return prev == null ? value : value * k + prev * (1 - k);
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error("CSV file has no data rows.");

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = lines[i].split(",").map((v) => v.trim());
    if (values.length !== headers.length) continue;

    const row = Object.fromEntries(headers.map((h, idx) => [h, values[idx]]));
    rows.push(row);
  }

  return rows;
}

function parseTime(value) {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  const normalized = String(value).replace(/\./g, "-").replace(" ", "T");
  const retry = new Date(normalized);
  if (!Number.isNaN(retry.getTime())) return retry;

  throw new Error(`Cannot parse time value: ${value}`);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hourToSession(hour) {
  if (hour >= 0 && hour < 7) return "ASIA";
  if (hour >= 7 && hour < 13) return "LONDON";
  if (hour >= 13 && hour < 22) return "NEWYORK";
  return "OFF";
}

function computeIndicators(rows) {
  let ema9 = null;
  let ema20 = null;
  let ema21 = null;
  let avgGain = null;
  let avgLoss = null;
  let prevClose = null;
  let atr = null;

  return rows.map((row, index) => {
    const time = parseTime(row.time || row.date || row.datetime);
    const open = toNumber(row.open);
    const high = toNumber(row.high);
    const low = toNumber(row.low);
    const close = toNumber(row.close);
    const spreadRaw = row.spread ?? row.spread_points ?? row["spread (points)"];
    const spreadPoints = toNumber(spreadRaw, 20);

    ema9 = ema(ema9, close, 9);
    ema20 = ema(ema20, close, 20);
    ema21 = ema(ema21, close, 21);

    let rsi = 50;
    if (prevClose != null) {
      const change = close - prevClose;
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);

      if (avgGain == null || avgLoss == null) {
        avgGain = gain;
        avgLoss = loss;
      } else {
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
      }

      if (avgLoss === 0) rsi = 100;
      else {
        const rs = avgGain / avgLoss;
        rsi = 100 - 100 / (1 + rs);
      }
    }

    const tr =
      prevClose == null
        ? high - low
        : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atr = atr == null ? tr : (atr * 13 + tr) / 14;
    prevClose = close;

    return {
      index,
      time,
      open,
      high,
      low,
      close,
      spread_points: spreadPoints,
      ema_fast: ema9 ?? close,
      ema20: ema20 ?? close,
      ema_slow: ema21 ?? close,
      rsi,
      atr_points: (atr ?? 0) / pointSize,
      body1_points: Math.abs(close - open) / pointSize,
      range1_points: Math.abs(high - low) / pointSize,
      close_to_ema20_points: Math.abs(close - (ema20 ?? close)) / pointSize,
      session: hourToSession(time.getHours()),
    };
  });
}

function detectTrendBias(bar) {
  if (
    bar.close > bar.ema_fast &&
    bar.ema_fast > bar.ema_slow &&
    bar.close > bar.ema20
  ) {
    return "BULL";
  }

  if (
    bar.close < bar.ema_fast &&
    bar.ema_fast < bar.ema_slow &&
    bar.close < bar.ema20
  ) {
    return "BEAR";
  }

  return "NEUTRAL";
}

function detectPullbackSetup(bar, bias) {
  const tolerance = bar.atr_points * pointSize * 0.18;

  if (bias === "BULL") {
    if (bar.low <= bar.ema_fast + tolerance || bar.low <= bar.ema20 + tolerance) {
      return "TREND_PULLBACK_BUY";
    }
  }

  if (bias === "BEAR") {
    if (bar.high >= bar.ema_fast - tolerance || bar.high >= bar.ema20 - tolerance) {
      return "TREND_PULLBACK_SELL";
    }
  }

  return "NONE";
}

function requestJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-api-secret": apiSecret,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: raw ? JSON.parse(raw) : {},
          });
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const result = await requestJson("GET", "/health");
      if (result.status === 200) return;
    } catch {}
    await delay(200);
  }

  throw new Error("Backtest server health timeout.");
}

function buildPayload(bar, bias, setupTag, hasPosition) {
  const trend =
    bias === "BULL" ? "up" : bias === "BEAR" ? "down" : "range";

  return {
    symbol,
    timeframe,
    session: bar.session,
    bid: bar.close,
    ask: bar.close + bar.spread_points * pointSize,
    spread: bar.spread_points,
    spread_points: bar.spread_points,
    has_position: hasPosition,
    position_type: "",
    ema_fast: Number(bar.ema_fast.toFixed(5)),
    ema_slow: Number(bar.ema_slow.toFixed(5)),
    ema20: Number(bar.ema20.toFixed(5)),
    rsi: Number(bar.rsi.toFixed(2)),
    atr: Number(bar.atr_points.toFixed(2)),
    atr_points: Number(bar.atr_points.toFixed(2)),
    trend,
    trend_bias: bias,
    setup_tag: setupTag,
    body1_points: Number(bar.body1_points.toFixed(1)),
    range1_points: Number(bar.range1_points.toFixed(1)),
    close_to_ema20_points: Number(bar.close_to_ema20_points.toFixed(1)),
    news_blocked: false,
    daily_loss_hit: false,
    candles: [],
  };
}

function deriveSlTp(decision, atrPoints) {
  let slPoints = toNumber(decision.sl_points, 0);
  const minSl = atrPoints * 0.8;
  const maxSl = atrPoints * 1.35;

  if (slPoints <= 0) slPoints = atrPoints * 0.95;
  if (slPoints < minSl) slPoints = minSl;
  if (slPoints > maxSl) slPoints = maxSl;

  let tpPoints = toNumber(decision.tp_points, 0);
  const minRr = 1.6;
  const preferredRr = atrPoints >= 1200 ? 2.2 : 2.0;
  if (tpPoints <= 0 || tpPoints < slPoints * minRr) {
    tpPoints = slPoints * preferredRr;
  }

  return { slPoints, tpPoints };
}

function closeReason(result) {
  return result === "WIN" ? "TP_OR_TRAIL" : "SL_OR_STOP";
}

function maxDrawdown(equityCurve) {
  let peak = 0;
  let maxDd = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

async function main() {
  const raw = await fs.readFile(csvPath, "utf8");
  const parsed = parseCsv(raw);
  const bars = computeIndicators(parsed);

  await fs.emptyDir(simDataDir);

  Object.assign(process.env, {
    ...process.env,
    PORT: String(port),
    API_SECRET: apiSecret,
    SIMULATION_MODE: process.env.SIMULATION_MODE || "1",
    ENABLE_MODEL_CALLS: process.env.ENABLE_MODEL_CALLS || "0",
    MAX_DAILY_CALLS: process.env.MAX_DAILY_CALLS || "500",
    MONTHLY_BUDGET_USD: process.env.MONTHLY_BUDGET_USD || "30",
    DATA_DIR: simDataDir,
  });

  const { server } = await import("./server.js");

  try {
    await waitForHealth();

    let openTrade = null;
    let balance = initialBalance;
    const equityCurve = [];
    const closedTrades = [];
    let opportunities = 0;
    let filtered = 0;

    for (let i = 30; i < bars.length; i += 1) {
      const bar = bars[i];

      if (openTrade) {
        const buy = openTrade.action === "BUY";
        const hitSl = buy ? bar.low <= openTrade.slPrice : bar.high >= openTrade.slPrice;
        const hitTp = buy ? bar.high >= openTrade.tpPrice : bar.low <= openTrade.tpPrice;

        if (hitSl || hitTp) {
          const result = hitSl ? "LOSS" : "WIN";
          const pnl = hitSl ? -openTrade.riskMoney : openTrade.riskMoney * openTrade.rrTarget;
          balance += pnl;
          equityCurve.push(Number((balance - initialBalance).toFixed(2)));

          const holdingMinutes = Math.max(
            1,
            (bar.time.getTime() - openTrade.openTime.getTime()) / 60000,
          );

          await requestJson("POST", "/trade-result", {
            trade_id: openTrade.tradeId,
            result,
            pnl: Number(pnl.toFixed(2)),
            rr_result: Number((result === "LOSS" ? -1 : openTrade.rrTarget).toFixed(2)),
            close_reason: closeReason(result),
            holding_minutes: Number(holdingMinutes.toFixed(1)),
          });

          closedTrades.push({
            action: openTrade.action,
            result,
            pnl: Number(pnl.toFixed(2)),
            rr: Number((result === "LOSS" ? -1 : openTrade.rrTarget).toFixed(2)),
            opened_at: openTrade.openTime.toISOString(),
            closed_at: bar.time.toISOString(),
          });

          openTrade = null;
        }
      }

      if (openTrade) continue;

      const bias = detectTrendBias(bar);
      const setupTag = detectPullbackSetup(bar, bias);
      const candidate = bias !== "NEUTRAL" && setupTag !== "NONE";
      if (!candidate) continue;

      opportunities += 1;

      const payload = buildPayload(bar, bias, setupTag, false);
      const decisionRes = await requestJson("POST", "/decision", payload);
      const decision = decisionRes.body;

      if (!["BUY", "SELL"].includes(decision.action)) {
        filtered += 1;
        continue;
      }

      const { slPoints, tpPoints } = deriveSlTp(decision, bar.atr_points);
      const riskPercent = toNumber(decision.risk_percent, riskPercentFallback);
      const riskMoney = balance * (riskPercent / 100);
      const rrTarget = tpPoints / slPoints;
      const entryPrice = bar.close;
      const slPrice =
        decision.action === "BUY"
          ? entryPrice - slPoints * pointSize
          : entryPrice + slPoints * pointSize;
      const tpPrice =
        decision.action === "BUY"
          ? entryPrice + tpPoints * pointSize
          : entryPrice - tpPoints * pointSize;

      openTrade = {
        tradeId: decision.trade_id,
        action: decision.action,
        openTime: bar.time,
        slPrice,
        tpPrice,
        riskMoney,
        rrTarget,
      };
    }

    const wins = closedTrades.filter((t) => t.result === "WIN").length;
    const losses = closedTrades.filter((t) => t.result === "LOSS").length;
    const grossProfit = closedTrades
      .filter((t) => t.pnl > 0)
      .reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(
      closedTrades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0),
    );

    const learningStatus = await requestJson("GET", "/learning-status");
    const usageStatus = await requestJson("GET", "/usage-status");

    console.log(
      JSON.stringify(
        {
          input: {
            csv: path.resolve(csvPath),
            bars: bars.length,
            symbol,
            timeframe,
            initial_balance: initialBalance,
          },
          results: {
            detected_opportunities: opportunities,
            trades_taken: closedTrades.length,
            filtered_or_skipped: filtered,
            win_rate_pct:
              closedTrades.length > 0
                ? Number(((wins / closedTrades.length) * 100).toFixed(2))
                : 0,
            profit_factor:
              grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : 0,
            max_drawdown_usd: Number(maxDrawdown(equityCurve).toFixed(2)),
            net_pnl_usd: Number((grossProfit - grossLoss).toFixed(2)),
            gross_profit_usd: Number(grossProfit.toFixed(2)),
            gross_loss_usd: Number(grossLoss.toFixed(2)),
            avg_rr:
              closedTrades.length > 0
                ? Number(
                    (
                      closedTrades.reduce((sum, t) => sum + t.rr, 0) /
                      closedTrades.length
                    ).toFixed(2),
                  )
                : 0,
            wins,
            losses,
          },
          learning_status: learningStatus.body,
          usage_status: usageStatus.body,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
