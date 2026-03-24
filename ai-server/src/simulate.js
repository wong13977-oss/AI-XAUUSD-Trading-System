import fs from "fs-extra";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const simDataDir = path.join(__dirname, "simulation_state");

const PORT = 3101;
const API_SECRET = "sim-secret";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-api-secret": API_SECRET,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const parsed = raw ? JSON.parse(raw) : {};
          resolve({ status: res.statusCode || 0, body: parsed });
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
      if (result.status === 200 && result.body.status === "ok") {
        return result.body;
      }
    } catch {}

    await delay(250);
  }

  throw new Error("Server did not become healthy in time.");
}

function makeScenario({
  symbol = "XAUUSD",
  timeframe = "PERIOD_M15",
  session,
  trend,
  trend_bias,
  setup_tag,
  rsi,
  atr_points,
  spread_points,
  body1_points,
  range1_points,
  close_to_ema20_points,
  result,
  pnl,
  rr_result,
  close_reason = "TP_OR_TRAIL",
  holding_minutes = 55,
}) {
  return {
    decision: {
      symbol,
      timeframe,
      session,
      bid: 3025.2,
      ask: 3025.5,
      spread: spread_points,
      spread_points,
      has_position: false,
      position_type: "",
      ema_fast: 3023.4,
      ema_slow: 3020.8,
      ema20: 3022.1,
      rsi,
      atr: atr_points,
      atr_points,
      trend,
      trend_bias,
      setup_tag,
      body1_points,
      range1_points,
      close_to_ema20_points,
      news_blocked: false,
      daily_loss_hit: false,
      candles: [
        { o: 3018.2, h: 3020.4, l: 3016.9, c: 3019.8 },
        { o: 3019.8, h: 3024.1, l: 3018.7, c: 3023.6 },
        { o: 3023.6, h: 3026.4, l: 3021.9, c: 3025.1 },
      ],
    },
    result: {
      result,
      pnl,
      rr_result,
      close_reason,
      holding_minutes,
    },
  };
}

async function main() {
  await fs.emptyDir(simDataDir);

  const env = {
    ...process.env,
    PORT: String(PORT),
    API_SECRET,
    SIMULATION_MODE: "1",
    ENABLE_MODEL_CALLS: "0",
    MAX_DAILY_CALLS: "100",
    MONTHLY_BUDGET_USD: "30",
    DATA_DIR: simDataDir,
  };
  Object.assign(process.env, env);

  const { server } = await import("./server.js");

  try {
    const health = await waitForHealth();
    console.log("[sim] health", health);

    const tradableScenarios = [
      makeScenario({
        session: "LONDON",
        trend: "up",
        trend_bias: "BULL",
        setup_tag: "TREND_PULLBACK_BUY",
        rsi: 58,
        atr_points: 220,
        spread_points: 18,
        body1_points: 58,
        range1_points: 112,
        close_to_ema20_points: 42,
        result: "WIN",
        pnl: 24.5,
        rr_result: 1.95,
      }),
      makeScenario({
        session: "LONDON",
        trend: "up",
        trend_bias: "BULL",
        setup_tag: "TREND_PULLBACK_BUY",
        rsi: 61,
        atr_points: 240,
        spread_points: 17,
        body1_points: 62,
        range1_points: 120,
        close_to_ema20_points: 38,
        result: "WIN",
        pnl: 26.2,
        rr_result: 2.05,
      }),
      makeScenario({
        session: "LONDON",
        trend: "up",
        trend_bias: "BULL",
        setup_tag: "TREND_PULLBACK_BUY",
        rsi: 56,
        atr_points: 210,
        spread_points: 19,
        body1_points: 51,
        range1_points: 101,
        close_to_ema20_points: 35,
        result: "LOSS",
        pnl: -12.4,
        rr_result: -1.0,
        close_reason: "SL_OR_STOP",
      }),
      makeScenario({
        session: "LONDON",
        trend: "up",
        trend_bias: "BULL",
        setup_tag: "TREND_PULLBACK_BUY",
        rsi: 60,
        atr_points: 235,
        spread_points: 16,
        body1_points: 57,
        range1_points: 118,
        close_to_ema20_points: 40,
        result: "WIN",
        pnl: 22.8,
        rr_result: 1.82,
      }),
      makeScenario({
        session: "LONDON",
        trend: "up",
        trend_bias: "BULL",
        setup_tag: "TREND_PULLBACK_BUY",
        rsi: 59,
        atr_points: 260,
        spread_points: 20,
        body1_points: 65,
        range1_points: 126,
        close_to_ema20_points: 44,
        result: "WIN",
        pnl: 28.1,
        rr_result: 2.1,
      }),
      makeScenario({
        session: "NEWYORK",
        trend: "down",
        trend_bias: "BEAR",
        setup_tag: "TREND_PULLBACK_SELL",
        rsi: 43,
        atr_points: 250,
        spread_points: 21,
        body1_points: 63,
        range1_points: 125,
        close_to_ema20_points: 48,
        result: "WIN",
        pnl: 21.9,
        rr_result: 1.74,
      }),
      makeScenario({
        session: "NEWYORK",
        trend: "down",
        trend_bias: "BEAR",
        setup_tag: "TREND_PULLBACK_SELL",
        rsi: 39,
        atr_points: 275,
        spread_points: 22,
        body1_points: 68,
        range1_points: 130,
        close_to_ema20_points: 50,
        result: "LOSS",
        pnl: -13.1,
        rr_result: -1.0,
        close_reason: "SL_OR_STOP",
      }),
      makeScenario({
        session: "NEWYORK",
        trend: "down",
        trend_bias: "BEAR",
        setup_tag: "TREND_PULLBACK_SELL",
        rsi: 41,
        atr_points: 290,
        spread_points: 20,
        body1_points: 71,
        range1_points: 136,
        close_to_ema20_points: 46,
        result: "WIN",
        pnl: 25.7,
        rr_result: 1.98,
      }),
      makeScenario({
        session: "NEWYORK",
        trend: "down",
        trend_bias: "BEAR",
        setup_tag: "TREND_PULLBACK_SELL",
        rsi: 44,
        atr_points: 265,
        spread_points: 19,
        body1_points: 60,
        range1_points: 121,
        close_to_ema20_points: 43,
        result: "WIN",
        pnl: 23.4,
        rr_result: 1.88,
      }),
      makeScenario({
        session: "NEWYORK",
        trend: "down",
        trend_bias: "BEAR",
        setup_tag: "TREND_PULLBACK_SELL",
        rsi: 40,
        atr_points: 520,
        spread_points: 19,
        body1_points: 74,
        range1_points: 190,
        close_to_ema20_points: 70,
        result: "WIN",
        pnl: 18.6,
        rr_result: 1.52,
        close_reason: "TP_OR_TRAIL",
      }),
    ];

    const decisionSummaries = [];

    for (const scenario of tradableScenarios) {
      const decisionRes = await requestJson("POST", "/decision", scenario.decision);
      if (decisionRes.status !== 200) {
        throw new Error(`Decision failed with status ${decisionRes.status}`);
      }

      const decision = decisionRes.body;
      decisionSummaries.push(decision);

      if (!["BUY", "SELL"].includes(decision.action)) {
        throw new Error(
          `Expected tradable action, got ${decision.action} for ${scenario.decision.setup_tag}`,
        );
      }

      const tradeResultRes = await requestJson("POST", "/trade-result", {
        trade_id: decision.trade_id,
        ...scenario.result,
      });

      if (tradeResultRes.status !== 200 || tradeResultRes.body.ok !== true) {
        throw new Error("Trade result reporting failed.");
      }
    }

    const skipDecisionRes = await requestJson("POST", "/decision", {
      symbol: "XAUUSD",
      timeframe: "PERIOD_M15",
      session: "ASIA",
      bid: 3025.2,
      ask: 3025.7,
      spread: 58,
      spread_points: 58,
      has_position: false,
      position_type: "",
      ema_fast: 3025.1,
      ema_slow: 3025.0,
      ema20: 3025.0,
      rsi: 50,
      atr: 90,
      atr_points: 90,
      trend: "range",
      trend_bias: "NEUTRAL",
      setup_tag: "NONE",
      body1_points: 12,
      range1_points: 26,
      close_to_ema20_points: 210,
      news_blocked: false,
      daily_loss_hit: false,
      candles: [{ o: 3025.1, h: 3025.8, l: 3024.9, c: 3025.2 }],
    });

    if (skipDecisionRes.body.action !== "SKIP") {
      throw new Error("Expected weak scenario to be skipped.");
    }

    const learningStatus = await requestJson("GET", "/learning-status");
    const usageStatus = await requestJson("GET", "/usage-status");
    const strategyNotes = await requestJson("GET", "/strategy-notes");

    const pending = await fs.readJson(path.join(simDataDir, "pending_trades.json"));

    if (learningStatus.body.global.total !== 10) {
      throw new Error(
        `Expected 10 learned trades, got ${learningStatus.body.global.total}`,
      );
    }

    if (Object.keys(pending).length !== 0) {
      throw new Error("Expected all pending decisions to be consumed.");
    }

    if (!strategyNotes.body.updated_at) {
      throw new Error("Expected strategy notes to refresh after 10 trades.");
    }

    if (
      usageStatus.body.usage.month_estimated_cost_usd >
      usageStatus.body.budget_usd
    ) {
      throw new Error("Estimated API cost exceeded monthly budget.");
    }

    console.log("[sim] decisions", decisionSummaries);
    console.log("[sim] learning", learningStatus.body);
    console.log("[sim] usage", usageStatus.body);
    console.log("[sim] strategy_notes", strategyNotes.body);
    console.log("[sim] skip_decision", skipDecisionRes.body);
    console.log("[sim] PASS");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("[sim] FAIL", error);
  process.exitCode = 1;
});
