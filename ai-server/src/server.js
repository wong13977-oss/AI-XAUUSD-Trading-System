import express from "express";
import dotenv from "dotenv";
import fs from "fs-extra";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = Number(process.env.PORT || 3000);
const API_SECRET = process.env.API_SECRET || "";
const SIMULATION_MODE = process.env.SIMULATION_MODE === "1";
const ENABLE_MODEL_CALLS = process.env.ENABLE_MODEL_CALLS !== "0";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.DATA_DIR || __dirname;

fs.ensureDirSync(DATA_DIR);

const TRADES_FILE = process.env.TRADES_FILE || path.join(DATA_DIR, "trades.json");
const PENDING_FILE =
  process.env.PENDING_FILE || path.join(DATA_DIR, "pending_trades.json");
const LEARNING_FILE =
  process.env.LEARNING_FILE || path.join(DATA_DIR, "learning_state.json");
const STRATEGY_NOTES_FILE =
  process.env.STRATEGY_NOTES_FILE ||
  path.join(DATA_DIR, "strategy_notes.json");
const USAGE_STATE_FILE =
  process.env.USAGE_STATE_FILE || path.join(DATA_DIR, "usage_state.json");
console.log("[PATH] TRADES_FILE =", TRADES_FILE);
console.log("[PATH] PENDING_FILE =", PENDING_FILE);
console.log("[PATH] LEARNING_FILE =", LEARNING_FILE);
console.log("[PATH] STRATEGY_NOTES_FILE =", STRATEGY_NOTES_FILE);
console.log("[PATH] USAGE_STATE_FILE =", USAGE_STATE_FILE);

const MONTHLY_BUDGET_USD = Number(process.env.MONTHLY_BUDGET_USD || 30);
const BASE_MONTHLY_TARGET_USD = Number(process.env.BASE_MONTHLY_TARGET_USD || 20);

const MAX_DAILY_CALLS = Number(process.env.MAX_DAILY_CALLS || 20);
const PRIMARY_REVIEW_MIN_CONF = 68;
const PRIMARY_REVIEW_MAX_CONF = 76;

const CHEAP_MODEL = process.env.CHEAP_MODEL || "gpt-5.4-mini";
const PRIMARY_MODEL = process.env.PRIMARY_MODEL || "gpt-5.4";
const ESTIMATED_CHEAP_CALL_USD = Number(
  process.env.ESTIMATED_CHEAP_CALL_USD || 0.03,
);
const ESTIMATED_PRIMARY_CALL_USD = Number(
  process.env.ESTIMATED_PRIMARY_CALL_USD || 0.12,
);
const ESTIMATED_SUMMARY_CALL_USD = Number(
  process.env.ESTIMATED_SUMMARY_CALL_USD || 0.18,
);
const ESTIMATED_ABNORMAL_CALL_USD = Number(
  process.env.ESTIMATED_ABNORMAL_CALL_USD || 0.08,
);

// =========================
// 基础工具
// =========================
function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toEaConfidence(value) {
  let n = Number(value ?? 0);
  if (!Number.isFinite(n)) n = 0;
  if (n > 0 && n <= 1) n = n * 100;
  return round2(clamp(n, 0, 100));
}

function makeTradeId() {
  return `t_${Date.now().toString().slice(-6)}_${crypto.randomBytes(2).toString("hex")}`;
}

function safeReadJson(path, fallback) {
  try {
    return fs.readJsonSync(path);
  } catch {
    return fallback;
  }
}

function safeWriteJson(path, data) {
  fs.ensureDirSync(requirePathDir(path));
  fs.writeJsonSync(path, data, { spaces: 2 });
}

function requirePathDir(targetPath) {
  return path.dirname(targetPath);
}

function authOk(req) {
  return req.headers["x-api-secret"] === API_SECRET;
}

function normalizeResultLabel(result) {
  const r = String(result || "").toUpperCase();
  if (r === "WIN") return "WIN";
  if (r === "LOSS") return "LOSS";
  return "BREAKEVEN";
}

function confidenceBucket(confidence) {
  const c = safeNumber(confidence, 0);
  if (c >= 90) return "90_100";
  if (c >= 80) return "80_89";
  if (c >= 70) return "70_79";
  if (c >= 60) return "60_69";
  return "LT60";
}

function logHeader(title) {
  console.log("\n==================================================");
  console.log(title);
  console.log("==================================================");
}

function logJson(label, obj) {
  console.log(label, JSON.stringify(obj, null, 2));
}

function pct(v) {
  return `${round2(v * 100)}%`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSessionBiasValue(value) {
  if (Number.isFinite(Number(value))) {
    return clamp(Number(value), -0.18, 0.18);
  }

  const text = String(value || "")
    .trim()
    .toLowerCase();

  if (!text) return 0;
  if (text === "positive") return 0.05;
  if (text === "slight_positive") return 0.03;
  if (text === "negative") return -0.06;
  if (text === "slight_negative") return -0.03;
  if (text === "neutral") return 0;
  return 0;
}

function normalizeBucketAdjustmentValue(value, fallback = 0) {
  if (Number.isFinite(Number(value))) {
    return clamp(Number(value), -0.2, 0.2);
  }

  const text = String(value || "")
    .trim()
    .toLowerCase();

  if (!text) return fallback;
  if (text === "boost" || text === "positive") return 0.06;
  if (text === "small" || text === "+small" || text === "slight_positive")
    return 0.03;
  if (text === "avoid" || text === "negative") return -0.08;
  if (text === "hard_avoid" || text === "block") return -0.14;
  return fallback;
}

function normalizeBucketRuleEntry(entry, fallbackAdjustment = 0) {
  if (typeof entry === "string") {
    return {
      bucket: entry,
      adjustment: normalizeBucketAdjustmentValue(fallbackAdjustment, fallbackAdjustment),
      risk_multiplier: 1,
      note: "",
    };
  }

  if (entry && typeof entry === "object") {
    return {
      bucket: String(entry.bucket || ""),
      adjustment: normalizeBucketAdjustmentValue(
        entry.adjustment,
        fallbackAdjustment,
      ),
      risk_multiplier: clamp(
        Number(entry.risk_multiplier ?? 1),
        0.25,
        1.25,
      ),
      note: String(entry.reason || entry.note || ""),
    };
  }

  return null;
}

function computeEntryQualityMetrics(data) {
  const atr = Math.max(1, safeNumber(data.atr_points ?? data.atr, 0));
  const range1 = safeNumber(data.range1_points, 0);
  const body1 = safeNumber(data.body1_points, 0);
  const closeToEma20 = safeNumber(data.close_to_ema20_points, 0);
  const spread = safeNumber(data.spread_points ?? data.spread, 0);

  const stretchRatio = closeToEma20 / atr;
  const rangeRatio = range1 / atr;
  const bodyRatio = body1 / atr;
  const bodyShare = range1 > 0 ? body1 / range1 : 0;

  return {
    atr,
    spread,
    stretchRatio,
    rangeRatio,
    bodyRatio,
    bodyShare,
    farExtended: stretchRatio >= 1.05,
    stretched: stretchRatio >= 0.82,
    mildlyExtended: stretchRatio >= 0.65,
    climactic: rangeRatio >= 1.2 && bodyShare >= 0.72,
    impulsive: rangeRatio >= 0.95 && bodyRatio >= 0.55,
  };
}

function signed(n) {
  const x = safeNumber(n, 0);
  return x > 0 ? `+${round2(x)}` : `${round2(x)}`;
}

function line(char = "-") {
  console.log(char.repeat(70));
}

function printDecisionSummary({
  tradeId,
  data,
  baseScore,
  learn,
  finalLocalScore,
  routeTier,
  apiCalled,
  modelUsed,
  response,
  strategy,
}) {
  const stats = learn?.stats || {};
  const bucketTotal = stats.total || 0;
  const bucketWinRate = stats.winRate || 0;
  const bucketAvgRR = stats.avgRR || 0;
  const bucketAvgPnl = stats.avgPnl || 0;

  line("=");
  console.log(
    `[DECISION] ${String(data.symbol || "").toUpperCase()} ${String(data.timeframe || "").toUpperCase()} | session=${String(data.session || "").toUpperCase()} | trend=${String(data.trend_bias || data.trend || "").toUpperCase()} | setup=${String(data.setup_tag || "").toUpperCase()}`,
  );
  console.log(
    `[LOCAL] base=${round2(baseScore)} adj=${signed(learn?.scoreAdj || 0)} final=${round2(finalLocalScore)} | note=${learn?.note || "NA"}`,
  );
  console.log(
    `[STRATEGY] adj=${signed(strategy?.strategyAdj || 0)} note=${strategy?.strategyNote || "NA"}`,
  );
  console.log(
    `[BUCKET] total=${bucketTotal} win=${pct(bucketWinRate)} rr=${round2(bucketAvgRR)} pnl=${round2(bucketAvgPnl)}`,
  );
  console.log(
    `[ROUTE] route=${routeTier} | api_call=${apiCalled ? "YES" : "NO"} | model=${modelUsed || "LOCAL"}`,
  );
  console.log(
    `[FINAL] action=${response.action} conf=${response.confidence} reason=${response.reason_code} sl=${response.sl_points} tp=${response.tp_points} risk=${response.risk_percent} trade_id=${tradeId}`,
  );
  line("=");
}

function printLearningSummary({ trade, learning, pendingMeta }) {
  const total = learning.global.total || 0;
  const wins = learning.global.wins || 0;
  const winRate = total > 0 ? wins / total : 0;
  const avgRR = total > 0 ? learning.global.rr_sum / total : 0;
  const avgPnl = total > 0 ? learning.global.pnl_sum / total : 0;

  line("=");
  console.log(
    `[LEARN] trade_id=${trade.trade_id || "NA"} result=${trade.result || "NA"} pnl=${round2(trade.pnl)} rr=${round2(trade.rr_result)} close=${trade.close_reason || "NA"}`,
  );
  console.log(
    `[GLOBAL] total=${total} win=${pct(winRate)} rr=${round2(avgRR)} pnl=${round2(avgPnl)}`,
  );

  if (pendingMeta?.bucket_key) {
    const bucket = learning.buckets[pendingMeta.bucket_key];
    const bucketStats = getBucketStats(bucket);

    console.log(
      `[BUCKET] ${pendingMeta.bucket_key} | total=${bucketStats.total} win=${pct(bucketStats.winRate)} rr=${round2(bucketStats.avgRR)} pnl=${round2(bucketStats.avgPnl)}`,
    );
  } else {
    console.log(`[BUCKET] no pending context matched`);
  }

  line("=");
}

function printModelCall(modelUsed, routeTier, tradeId) {
  console.log(
    `[MODEL] calling=${modelUsed} | route=${routeTier} | trade_id=${tradeId}`,
  );
}

function printUsageSummary(usage) {
  const remainingBudget = round2(
    MONTHLY_BUDGET_USD - safeNumber(usage?.month_estimated_cost_usd, 0),
  );

  console.log(
    `[USAGE] month_calls=${usage?.month_calls || 0} day_calls=${usage?.day_calls || 0} est_cost_usd=${round2(usage?.month_estimated_cost_usd || 0)} remaining_usd=${remainingBudget}`,
  );
  console.log(
    `[USAGE] cheap=${usage?.cheap_calls || 0} primary=${usage?.primary_calls || 0} summary=${usage?.summary_calls || 0} abnormal=${usage?.abnormal_calls || 0}`,
  );
}

function printLearningSnapshot(learning) {
  const total = learning?.global?.total || 0;
  const wins = learning?.global?.wins || 0;
  const losses = learning?.global?.losses || 0;
  const breakevens = learning?.global?.breakevens || 0;
  const winRate = total > 0 ? wins / total : 0;
  const avgRR = total > 0 ? learning.global.rr_sum / total : 0;
  const avgPnl = total > 0 ? learning.global.pnl_sum / total : 0;
  const buckets = Object.values(learning?.buckets || {});

  console.log(
    `[LEARNING] trades=${total} wins=${wins} losses=${losses} breakevens=${breakevens} win=${pct(winRate)} avg_rr=${round2(avgRR)} avg_pnl=${round2(avgPnl)}`,
  );
  console.log(
    `[LEARNING] buckets=${buckets.length} updated_at=${learning?.updated_at || "NA"}`,
  );

  const topBuckets = buckets
    .filter((b) => (b.total || 0) > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0))
    .slice(0, 3);

  if (topBuckets.length === 0) {
    console.log("[BUCKETS] no learned buckets yet");
    return;
  }

  topBuckets.forEach((bucket, index) => {
    const stats = getBucketStats(bucket);
    console.log(
      `[BUCKETS] #${index + 1} ${bucket.key} | total=${stats.total} win=${pct(stats.winRate)} rr=${round2(stats.avgRR)} pnl=${round2(stats.avgPnl)}`,
    );
  });
}

function printStrategyNotesSnapshot(notes) {
  const noteCount = Array.isArray(notes?.notes) ? notes.notes.length : 0;
  const boostCount = Array.isArray(notes?.boost_buckets)
    ? notes.boost_buckets.length
    : 0;
  const avoidCount = Array.isArray(notes?.avoid_buckets)
    ? notes.avoid_buckets.length
    : 0;
  const sessionBiasKeys = Object.keys(notes?.session_bias || {});

  console.log(
    `[STRATEGY_NOTES] updated_at=${notes?.updated_at || "NA"} notes=${noteCount} boost=${boostCount} avoid=${avoidCount} session_bias=${sessionBiasKeys.length}`,
  );

  if (noteCount > 0) {
    notes.notes.slice(0, 3).forEach((note, index) => {
      console.log(`[STRATEGY_NOTES] note_${index + 1}=${note}`);
    });
  } else {
    console.log("[STRATEGY_NOTES] no notes yet");
  }
}

function buildStartupSnapshot() {
  const usage = loadUsageState();
  const learning = loadLearning();
  const notes = loadStrategyNotes();
  const pending = loadPending();
  const total = learning?.global?.total || 0;
  const wins = learning?.global?.wins || 0;
  const losses = learning?.global?.losses || 0;
  const breakevens = learning?.global?.breakevens || 0;
  const winRate = total > 0 ? wins / total : 0;
  const avgRR = total > 0 ? learning.global.rr_sum / total : 0;
  const avgPnl = total > 0 ? learning.global.pnl_sum / total : 0;
  const buckets = Object.values(learning?.buckets || {});
  const topBuckets = buckets
    .filter((b) => (b.total || 0) > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0))
    .slice(0, 3)
    .map((bucket) => {
      const stats = getBucketStats(bucket);
      return {
        key: bucket.key,
        total: stats.total,
        win_rate: round2(stats.winRate * 100),
        avg_rr: round2(stats.avgRR),
        avg_pnl: round2(stats.avgPnl),
      };
    });

  return {
    start: {
      port: PORT,
      cheap_model: CHEAP_MODEL,
      primary_model: PRIMARY_MODEL,
      simulation_mode: SIMULATION_MODE,
      model_calls_enabled: ENABLE_MODEL_CALLS,
      max_daily_calls: MAX_DAILY_CALLS,
      monthly_budget_usd: MONTHLY_BUDGET_USD,
      data_files: {
        trades: TRADES_FILE,
        pending: PENDING_FILE,
        learning: LEARNING_FILE,
        strategy_notes: STRATEGY_NOTES_FILE,
        usage: USAGE_STATE_FILE,
      },
    },
    usage: {
      ...usage,
      remaining_budget_usd: round2(
        MONTHLY_BUDGET_USD - safeNumber(usage?.month_estimated_cost_usd, 0),
      ),
    },
    learning: {
      total,
      wins,
      losses,
      breakevens,
      win_rate: round2(winRate * 100),
      avg_rr: round2(avgRR),
      avg_pnl: round2(avgPnl),
      bucket_count: buckets.length,
      updated_at: learning?.updated_at || "",
      top_buckets: topBuckets,
    },
    strategy_notes: {
      updated_at: notes?.updated_at || "",
      notes_count: Array.isArray(notes?.notes) ? notes.notes.length : 0,
      notes_preview: Array.isArray(notes?.notes) ? notes.notes.slice(0, 3) : [],
      boost_count: Array.isArray(notes?.boost_buckets)
        ? notes.boost_buckets.length
        : 0,
      avoid_count: Array.isArray(notes?.avoid_buckets)
        ? notes.avoid_buckets.length
        : 0,
      session_bias_keys: Object.keys(notes?.session_bias || {}),
    },
    pending: {
      open_pending: Object.keys(pending || {}).length,
    },
    generated_at: nowIso(),
  };
}

function printStartupSnapshot() {
  const snapshot = buildStartupSnapshot();

  line("=");
  console.log("[SNAPSHOT] current server state");
  printUsageSummary(snapshot.usage);
  printLearningSnapshot(loadLearning());
  printStrategyNotesSnapshot(loadStrategyNotes());
  console.log(`[PENDING] open_pending=${snapshot.pending.open_pending}`);
  line("=");
}

function printHealthStartup() {
  line("=");
  console.log(`[START] AI Server running on port ${PORT}`);
  console.log(`[START] CHEAP_MODEL=${CHEAP_MODEL}`);
  console.log(`[START] PRIMARY_MODEL=${PRIMARY_MODEL}`);
  console.log(`[START] simulation_mode=${SIMULATION_MODE}`);
  console.log(`[START] model_calls_enabled=${ENABLE_MODEL_CALLS}`);
  console.log(
    `[START] data_files=${TRADES_FILE}, ${PENDING_FILE}, ${LEARNING_FILE}`,
  );
  console.log(`[START] strategy_file=${STRATEGY_NOTES_FILE}`);
  console.log(`[START] usage_file=${USAGE_STATE_FILE}`);
  console.log(`[START] max_daily_calls=${MAX_DAILY_CALLS}`);
  console.log(`[START] monthly_budget_usd=${MONTHLY_BUDGET_USD}`);
  line("=");
}

// =========================
// 文件存取
// =========================
function loadTrades() {
  return safeReadJson(TRADES_FILE, []);
}

function saveTrade(trade) {
  const arr = loadTrades();
  arr.push(trade);
  safeWriteJson(TRADES_FILE, arr);
}

function loadPending() {
  return safeReadJson(PENDING_FILE, {});
}

function savePending(pending) {
  safeWriteJson(PENDING_FILE, pending);
}

function loadLearning() {
  return safeReadJson(LEARNING_FILE, {
    version: 2,
    created_at: nowIso(),
    updated_at: nowIso(),
    global: {
      total: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      pnl_sum: 0,
      rr_sum: 0,
      avg_holding_minutes: 0,
    },
    buckets: {},
  });
}

function saveLearning(learning) {
  learning.updated_at = nowIso();
  safeWriteJson(LEARNING_FILE, learning);
}

function loadStrategyNotes() {
  return safeReadJson(STRATEGY_NOTES_FILE, {
    updated_at: "",
    notes: [],
    boost_buckets: [],
    avoid_buckets: [],
    session_bias: {},
    confidence_adjustments: {},
  });
}

function saveStrategyNotes(data) {
  safeWriteJson(STRATEGY_NOTES_FILE, data);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function loadUsageState() {
  const data = safeReadJson(USAGE_STATE_FILE, {
    month_key: "",
    month_calls: 0,
    month_estimated_cost_usd: 0,
    day_key: "",
    day_calls: 0,
    cheap_calls: 0,
    primary_calls: 0,
    summary_calls: 0,
    abnormal_calls: 0,
  });

  const currentMonth = monthKey();
  const currentDay = todayKey();

  if (data.month_key !== currentMonth) {
    data.month_key = currentMonth;
    data.month_calls = 0;
    data.month_estimated_cost_usd = 0;
    data.cheap_calls = 0;
    data.primary_calls = 0;
    data.summary_calls = 0;
    data.abnormal_calls = 0;
  }

  if (data.day_key !== currentDay) {
    data.day_key = currentDay;
    data.day_calls = 0;
  }

  if (!Number.isFinite(Number(data.month_estimated_cost_usd))) {
    data.month_estimated_cost_usd = round2(
      safeNumber(data.cheap_calls, 0) * ESTIMATED_CHEAP_CALL_USD +
        safeNumber(data.primary_calls, 0) * ESTIMATED_PRIMARY_CALL_USD +
        safeNumber(data.summary_calls, 0) * ESTIMATED_SUMMARY_CALL_USD +
        safeNumber(data.abnormal_calls, 0) * ESTIMATED_ABNORMAL_CALL_USD,
    );
  }

  return data;
}

function saveUsageState(data) {
  safeWriteJson(USAGE_STATE_FILE, data);
}

function estimateCallCostUsd(type) {
  if (type === "cheap") return ESTIMATED_CHEAP_CALL_USD;
  if (type === "primary") return ESTIMATED_PRIMARY_CALL_USD;
  if (type === "summary") return ESTIMATED_SUMMARY_CALL_USD;
  if (type === "abnormal") return ESTIMATED_ABNORMAL_CALL_USD;
  return ESTIMATED_CHEAP_CALL_USD;
}

function registerApiCall(type) {
  const usage = loadUsageState();
  const estimatedCost = estimateCallCostUsd(type);
  usage.month_calls += 1;
  usage.day_calls += 1;
  usage.month_estimated_cost_usd = round2(
    safeNumber(usage.month_estimated_cost_usd, 0) + estimatedCost,
  );

  if (type === "cheap") usage.cheap_calls += 1;
  if (type === "primary") usage.primary_calls += 1;
  if (type === "summary") usage.summary_calls += 1;
  if (type === "abnormal") usage.abnormal_calls += 1;

  saveUsageState(usage);
  return usage;
}

function canUseApiCall(type = "cheap") {
  const usage = loadUsageState();
  if (usage.day_calls >= MAX_DAILY_CALLS) {
    return { ok: false, reason: "DAILY_LIMIT_REACHED", usage };
  }

  const projectedCost =
    safeNumber(usage.month_estimated_cost_usd, 0) + estimateCallCostUsd(type);

  if (projectedCost > MONTHLY_BUDGET_USD) {
    return {
      ok: false,
      reason: "MONTHLY_BUDGET_REACHED",
      usage,
      projected_cost_usd: round2(projectedCost),
    };
  }

  return {
    ok: true,
    reason: "OK",
    usage,
    projected_cost_usd: round2(projectedCost),
  };
}

// =========================
// 分桶 key
// =========================
function normalizeSession(session) {
  const s = String(session || "").toUpperCase();
  if (!s) return "NA";
  return s;
}

function normalizeTrendBias(bias) {
  const b = String(bias || "").toUpperCase();
  if (!b) return "NA";
  return b;
}

function normalizeSetupTag(tag) {
  const t = String(tag || "")
    .toUpperCase()
    .trim();
  if (!t) return "NA";
  return t;
}

function buildBucketKey(data) {
  return [
    String(data.symbol || "NA").toUpperCase(),
    String(data.timeframe || "NA").toUpperCase(),
    normalizeTrendBias(data.trend_bias),
    normalizeSetupTag(data.setup_tag),
    normalizeSession(data.session),
  ].join("|");
}

function ensureBucket(learning, key) {
  if (!learning.buckets[key]) {
    learning.buckets[key] = {
      key,
      total: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      pnl_sum: 0,
      rr_sum: 0,
      avg_holding_minutes: 0,
      route_tiers: {},
      confidence_buckets: {},
      actions: {
        BUY: { total: 0, wins: 0, losses: 0, breakevens: 0 },
        SELL: { total: 0, wins: 0, losses: 0, breakevens: 0 },
      },
      last_updated: null,
    };
  }
  return learning.buckets[key];
}

function getBucketStats(bucket) {
  if (!bucket || !bucket.total) {
    return {
      total: 0,
      winRate: 0,
      lossRate: 0,
      breakevenRate: 0,
      avgRR: 0,
      avgPnl: 0,
      avgHoldingMinutes: 0,
    };
  }

  return {
    total: bucket.total,
    winRate: bucket.wins / bucket.total,
    lossRate: bucket.losses / bucket.total,
    breakevenRate: bucket.breakevens / bucket.total,
    avgRR: bucket.rr_sum / bucket.total,
    avgPnl: bucket.pnl_sum / bucket.total,
    avgHoldingMinutes: bucket.avg_holding_minutes || 0,
  };
}

// =========================
// 学习状态更新
// =========================
function updateGlobalStats(learning, result, pnl, rr, holdingMinutes) {
  const g = learning.global;
  const beforeTotal = g.total;

  g.total += 1;
  g.pnl_sum += pnl;
  g.rr_sum += rr;

  if (result === "WIN") g.wins += 1;
  else if (result === "LOSS") g.losses += 1;
  else g.breakevens += 1;

  g.avg_holding_minutes =
    g.total > 0
      ? (g.avg_holding_minutes * beforeTotal + holdingMinutes) / g.total
      : 0;
}

function updateBucketStats(
  bucket,
  pendingMeta,
  result,
  pnl,
  rr,
  holdingMinutes,
) {
  const beforeTotal = bucket.total;

  bucket.total += 1;
  bucket.pnl_sum += pnl;
  bucket.rr_sum += rr;

  if (result === "WIN") bucket.wins += 1;
  else if (result === "LOSS") bucket.losses += 1;
  else bucket.breakevens += 1;

  bucket.avg_holding_minutes =
    bucket.total > 0
      ? (bucket.avg_holding_minutes * beforeTotal + holdingMinutes) /
        bucket.total
      : 0;

  const rt = String(pendingMeta.route_tier || "UNKNOWN").toUpperCase();
  if (!bucket.route_tiers[rt]) {
    bucket.route_tiers[rt] = { total: 0, wins: 0, losses: 0, breakevens: 0 };
  }
  bucket.route_tiers[rt].total += 1;
  if (result === "WIN") bucket.route_tiers[rt].wins += 1;
  else if (result === "LOSS") bucket.route_tiers[rt].losses += 1;
  else bucket.route_tiers[rt].breakevens += 1;

  const cb = String(pendingMeta.confidence_bucket || "NA").toUpperCase();
  if (!bucket.confidence_buckets[cb]) {
    bucket.confidence_buckets[cb] = {
      total: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
    };
  }
  bucket.confidence_buckets[cb].total += 1;
  if (result === "WIN") bucket.confidence_buckets[cb].wins += 1;
  else if (result === "LOSS") bucket.confidence_buckets[cb].losses += 1;
  else bucket.confidence_buckets[cb].breakevens += 1;

  const action = String(pendingMeta.action || "SKIP").toUpperCase();
  if (!bucket.actions[action]) {
    bucket.actions[action] = { total: 0, wins: 0, losses: 0, breakevens: 0 };
  }
  bucket.actions[action].total += 1;
  if (result === "WIN") bucket.actions[action].wins += 1;
  else if (result === "LOSS") bucket.actions[action].losses += 1;
  else bucket.actions[action].breakevens += 1;

  bucket.last_updated = nowIso();
}

function updateLearningFromTrade(trade, pendingMeta) {
  const learning = loadLearning();

  const result = normalizeResultLabel(trade.result);
  const pnl = safeNumber(trade.pnl, 0);
  const rr = safeNumber(trade.rr_result, 0);
  const holdingMinutes = safeNumber(trade.holding_minutes, 0);

  updateGlobalStats(learning, result, pnl, rr, holdingMinutes);

  if (pendingMeta && pendingMeta.bucket_key) {
    const bucket = ensureBucket(learning, pendingMeta.bucket_key);
    updateBucketStats(bucket, pendingMeta, result, pnl, rr, holdingMinutes);
  }

  saveLearning(learning);
  return learning;
}

// =========================
// Pending 决策存取
// =========================
function savePendingDecision(tradeId, snapshot) {
  const all = safeReadJson(PENDING_FILE, {});
  console.log("[PENDING][SAVE] file =", PENDING_FILE, "tradeId =", tradeId);

  all[tradeId] = {
    ...(snapshot || {}),
    saved_at: new Date().toISOString(),
  };

  safeWriteJson(PENDING_FILE, all);
  console.log("[PENDING][SAVE_OK] count =", Object.keys(all).length);
}

function consumePendingDecision(tradeId) {
  const all = safeReadJson(PENDING_FILE, {});
  console.log("[PENDING][CONSUME] file =", PENDING_FILE, "tradeId =", tradeId);

  const hit = all[tradeId] || null;

  if (hit) {
    delete all[tradeId];
    safeWriteJson(PENDING_FILE, all);
    console.log(
      "[PENDING][HIT] tradeId =",
      tradeId,
      "remaining =",
      Object.keys(all).length,
    );
    return hit;
  }

  console.log(
    "[PENDING][MISS] tradeId =",
    tradeId,
    "known_ids =",
    Object.keys(all).slice(0, 20),
  );
  return null;
}

function buildSnapshotForLearning(data, response) {
  const bucketKey = buildBucketKey(data);

  return {
    bucket_key: bucketKey,
    symbol: String(data.symbol || "").toUpperCase(),
    timeframe: String(data.timeframe || "").toUpperCase(),
    trend: String(data.trend || "").toLowerCase(),
    trend_bias: normalizeTrendBias(data.trend_bias),
    setup_tag: normalizeSetupTag(data.setup_tag),
    session: normalizeSession(data.session),
    route_tier: String(response.route_tier || "").toUpperCase(),
    source: String(response.source || "").toUpperCase(),
    model: String(response.model || "").toUpperCase(),
    action: String(response.action || "SKIP").toUpperCase(),
    confidence: safeNumber(response.confidence, 0),
    confidence_bucket: confidenceBucket(response.confidence),
    spread_points: safeNumber(data.spread_points ?? data.spread, 0),
    atr_points: safeNumber(data.atr_points ?? data.atr, 0),
    rsi: safeNumber(data.rsi, 0),
    body1_points: safeNumber(data.body1_points, 0),
    range1_points: safeNumber(data.range1_points, 0),
    close_to_ema20_points: safeNumber(data.close_to_ema20_points, 0),
  };
}

// =========================
// 本地评分（保留你原来的省 API 方向）
// =========================
function localScore(data) {
  let score = 0;

  const trend = String(data.trend || "").toLowerCase();
  const trendBias = normalizeTrendBias(data.trend_bias);
  const setup = normalizeSetupTag(data.setup_tag);

  const rsi = safeNumber(data.rsi, 0);
  const atrPoints = safeNumber(data.atr_points ?? data.atr, 0);
  const spread = safeNumber(data.spread_points ?? data.spread, 999);
  const quality = computeEntryQualityMetrics(data);

  const body1 = safeNumber(data.body1_points, 0);
  const range1 = safeNumber(data.range1_points, 0);
  const closeToEma20 = safeNumber(data.close_to_ema20_points, 999);

  const hasPosition = data.has_position === true;
  const newsBlocked = data.news_blocked === true;
  const dailyLossHit = data.daily_loss_hit === true;

  // 趋势方向
  if ((trend === "up" || trendBias === "BULL") && rsi >= 50) score += 0.22;
  if ((trend === "down" || trendBias === "BEAR") && rsi <= 50) score += 0.22;

  // setup 和方向一致
  if (setup.includes("BUY") && (trend === "up" || trendBias === "BULL"))
    score += 0.18;
  if (setup.includes("SELL") && (trend === "down" || trendBias === "BEAR"))
    score += 0.18;

  // ATR
  if (atrPoints >= 130) score += 0.1;
  if (atrPoints >= 220) score += 0.08;

  // 点差
  if (spread <= 30) score += 0.15;
  else if (spread <= 50) score += 0.08;

  // K线质量
  if (body1 >= 80) score += 0.08;
  else if (body1 >= 45) score += 0.05;
  if (range1 >= 140) score += 0.07;
  else if (range1 >= 90) score += 0.04;

  // 接近 EMA20 回踩
  if (closeToEma20 <= 150) score += 0.1;
  else if (closeToEma20 <= 220) score += 0.05;

  if (quality.mildlyExtended) score -= 0.05;
  if (quality.stretched) score -= 0.11;
  if (quality.climactic) score -= 0.14;
  else if (quality.impulsive) score -= 0.07;
  if (spread > 35) score -= 0.04;

  // 风险抑制
  if (hasPosition) score -= 0.2;
  if (newsBlocked) score -= 0.4;
  if (dailyLossHit) score -= 0.5;

  return clamp(score, 0, 1);
}

function detectAbnormalMarket(data) {
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const atr = safeNumber(data.atr_points ?? data.atr, 0);
  const range1 = safeNumber(data.range1_points, 0);
  const closeToEma20 = safeNumber(data.close_to_ema20_points, 0);

  const reasons = [];

  if (spread > 60) reasons.push("HIGH_SPREAD");
  if (atr > 600) reasons.push("HIGH_ATR");
  if (range1 > 420) reasons.push("LARGE_RANGE_BAR");
  if (closeToEma20 > 340) reasons.push("FAR_FROM_EMA20");

  return {
    abnormal: reasons.length > 0,
    reasons,
  };
}

// =========================
// 学习修正（关键）
// =========================
function learningAdjustments(data, baseScore) {
  const learning = loadLearning();
  const bucketKey = buildBucketKey(data);
  const bucket = learning.buckets[bucketKey];
  const stats = getBucketStats(bucket);

  let scoreAdj = 0;
  let skip = false;
  let note = stats.total > 0 ? "EARLY_HISTORY" : "NO_HISTORY";

  // 样本不足，不做激进调整
  if (stats.total < 4) {
    return {
      bucketKey,
      stats,
      scoreAdj,
      learnedScore: clamp(baseScore + scoreAdj, 0, 1),
      skip,
      note,
    };
  }

  // 正常加减分
  if (stats.winRate >= 0.62 && stats.avgRR > 0.15) {
    scoreAdj += 0.1;
    note = "GOOD_BUCKET";
  } else if (stats.winRate >= 0.55 && stats.avgRR >= 0) {
    scoreAdj += 0.05;
    note = "DECENT_BUCKET";
  } else if (stats.total >= 4 && stats.winRate < 0.35 && stats.avgRR < 0) {
    scoreAdj -= 0.08;
    note = "EARLY_WEAK_BUCKET";
  } else if (stats.winRate < 0.33 && stats.total >= 10) {
    scoreAdj -= 0.2;
    note = "BAD_BUCKET";
  } else if (stats.winRate < 0.4 && stats.total >= 8) {
    scoreAdj -= 0.12;
    note = "WEAK_BUCKET";
  } else {
    note = "NEUTRAL_BUCKET";
  }

  // 极差 bucket：直接拦
  if (stats.total >= 10 && stats.winRate < 0.28 && stats.avgRR < -0.1) {
    skip = true;
    note = "HARD_BLOCK_BAD_BUCKET";
  }

  return {
    bucketKey,
    stats,
    scoreAdj,
    learnedScore: clamp(baseScore + scoreAdj, 0, 1),
    skip,
    note,
  };
}

function applyStrategyNotesAdjustment(data, score) {
  const notes = loadStrategyNotes();
  const bucketKey = buildBucketKey(data);

  let adj = 0;
  let riskMultiplier = 1;
  let note = "NO_STRATEGY_NOTE";

  const boostRule = asArray(notes.boost_buckets)
    .map((entry) => normalizeBucketRuleEntry(entry, 0.04))
    .find((entry) => entry?.bucket === bucketKey);

  if (boostRule) {
    adj += boostRule.adjustment;
    riskMultiplier *= boostRule.risk_multiplier;
    note = boostRule.note ? `BOOST_BUCKET:${boostRule.note}` : "BOOST_BUCKET";
  }

  const avoidRule = asArray(notes.avoid_buckets)
    .map((entry) => normalizeBucketRuleEntry(entry, -0.08))
    .find((entry) => entry?.bucket === bucketKey);

  if (avoidRule) {
    adj += avoidRule.adjustment;
    riskMultiplier *= Math.min(1, avoidRule.risk_multiplier || 0.75);
    note = avoidRule.note ? `AVOID_BUCKET:${avoidRule.note}` : "AVOID_BUCKET";
  }

  const session = String(data.session || "").toUpperCase();
  if (notes.session_bias && notes.session_bias[session] != null) {
    const sessionAdj = normalizeSessionBiasValue(notes.session_bias[session]);
    adj += sessionAdj;
    if (sessionAdj !== 0) {
      note = `SESSION_BIAS_${session}`;
    }
  }

  const quality = computeEntryQualityMetrics(data);
  for (const rule of asArray(notes.confidence_adjustments)) {
    if (!rule || typeof rule !== "object") continue;

    if (rule.type === "stretch_penalty") {
      const minStretch = Number(rule.min_stretch_ratio ?? 0.7);
      if (quality.stretchRatio >= minStretch) {
        adj += normalizeBucketAdjustmentValue(rule.adjustment, -0.08);
        riskMultiplier *= clamp(Number(rule.risk_multiplier ?? 0.8), 0.25, 1);
        note = "STRETCH_PENALTY";
      }
    }

    if (rule.type === "session_setup_penalty") {
      const matchSession =
        !rule.session || String(rule.session).toUpperCase() === session;
      const matchSetup =
        !rule.setup_tag ||
        String(rule.setup_tag).toUpperCase() === normalizeSetupTag(data.setup_tag);
      const matchTrend =
        !rule.trend_bias ||
        String(rule.trend_bias).toUpperCase() === normalizeTrendBias(data.trend_bias);

      if (matchSession && matchSetup && matchTrend) {
        adj += normalizeBucketAdjustmentValue(rule.adjustment, -0.06);
        riskMultiplier *= clamp(Number(rule.risk_multiplier ?? 0.8), 0.25, 1);
        note = "SESSION_SETUP_PENALTY";
      }
    }
  }

  return {
    strategyAdj: adj,
    riskMultiplier: clamp(riskMultiplier, 0.25, 1.2),
    strategyNote: note,
    scoreAfterStrategy: clamp(score + adj, 0, 1),
  };
}

function hasLiveModelAccess() {
  return ENABLE_MODEL_CALLS && !SIMULATION_MODE && !!process.env.OPENAI_API_KEY;
}

function decisionSourceLabel() {
  return hasLiveModelAccess() ? "GPT" : "MODEL_FALLBACK";
}

function decisionModelLabel(modelUsed) {
  return hasLiveModelAccess() ? modelUsed : "LOCAL_PRO";
}

function pickDirectionalAction(data) {
  const trend = String(data.trend || "").toLowerCase();
  const trendBias = normalizeTrendBias(data.trend_bias);
  const setup = normalizeSetupTag(data.setup_tag);

  if (setup.includes("SELL") || trendBias === "BEAR" || trend === "down") {
    return "SELL";
  }

  if (setup.includes("BUY") || trendBias === "BULL" || trend === "up") {
    return "BUY";
  }

  return "SKIP";
}

function buildProfessionalDecision(data) {
  const actionBias = pickDirectionalAction(data);
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const atr = safeNumber(data.atr_points ?? data.atr, 0);
  const rsi = safeNumber(data.rsi, 50);
  const body1 = safeNumber(data.body1_points, 0);
  const range1 = safeNumber(data.range1_points, 0);
  const closeToEma20 = safeNumber(data.close_to_ema20_points, 0);
  const hasPosition = data.has_position === true;
  const newsBlocked = data.news_blocked === true;
  const dailyLossHit = data.daily_loss_hit === true;
  const setup = normalizeSetupTag(data.setup_tag);
  const trendBias = normalizeTrendBias(data.trend_bias);
  const quality = computeEntryQualityMetrics(data);

  if (hasPosition) {
    return {
      action: "SKIP",
      confidence: 35,
      reason_code: "POSITION_ALREADY_OPEN",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (newsBlocked || dailyLossHit) {
    return {
      action: "SKIP",
      confidence: 30,
      reason_code: newsBlocked ? "NEWS_RISK_BLOCK" : "DAILY_LOSS_BLOCK",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (actionBias === "SKIP") {
    return {
      action: "SKIP",
      confidence: 38,
      reason_code: "NO_DIRECTIONAL_EDGE",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (spread > 55) {
    return {
      action: "SKIP",
      confidence: 34,
      reason_code: "PRO_SPREAD_TOO_WIDE",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (atr < 110) {
    return {
      action: "SKIP",
      confidence: 36,
      reason_code: "PRO_RANGE_TOO_SMALL",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (quality.climactic || (range1 >= atr * 1.45 && body1 >= range1 * 0.76)) {
    return {
      action: "SKIP",
      confidence: 44,
      reason_code: "PRO_CLIMACTIC_BAR_SKIP",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (quality.farExtended || closeToEma20 >= atr * 0.9) {
    return {
      action: "SKIP",
      confidence: 46,
      reason_code: "PRO_CHASE_EXTENSION_SKIP",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  let confidence = 67;

  if (setup.includes("PULLBACK")) confidence += 8;
  if (spread <= 25) confidence += 5;
  else if (spread <= 40) confidence += 3;
  if (atr >= 160 && atr <= 420) confidence += 5;
  if (atr > 420 && atr <= 700) confidence += 3;
  if (body1 >= 35 && body1 <= atr * 0.5) confidence += 3;
  if (closeToEma20 <= atr * 0.38) confidence += 5;
  else if (closeToEma20 <= atr * 0.55) confidence += 2;
  if (quality.stretched) confidence -= 10;
  else if (quality.mildlyExtended) confidence -= 4;
  if (quality.impulsive) confidence -= 6;

  if (actionBias === "BUY") {
    if (trendBias === "BULL") confidence += 4;
    if (rsi >= 51 && rsi <= 67) confidence += 5;
    else if (rsi > 75) confidence -= 12;
    else if (rsi < 46) confidence -= 7;
  }

  if (actionBias === "SELL") {
    if (trendBias === "BEAR") confidence += 4;
    if (rsi <= 49 && rsi >= 33) confidence += 5;
    else if (rsi < 25) confidence -= 12;
    else if (rsi > 54) confidence -= 7;
  }

  confidence = clamp(confidence, 48, 95);

  const slPoints = round2(clamp(atr * 0.92, 130, 950));
  const rrTarget =
    confidence >= 82 ? 2.1 : confidence >= 76 ? 1.9 : confidence >= 70 ? 1.75 : 1.6;
  const tpPoints = round2(slPoints * rrTarget);
  const riskPercent = round2(
    confidence >= 82 ? 0.4 : confidence >= 76 ? 0.32 : 0.24,
  );

  if (confidence < 70) {
    return {
      action: "SKIP",
      confidence,
      reason_code: "PRO_EDGE_BELOW_THRESHOLD",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  return {
    action: actionBias,
    confidence,
    reason_code: `PRO_${setup || "TREND"}`,
    sl_points: slPoints,
    tp_points: tpPoints,
    risk_percent: riskPercent,
  };
}

function reviewAbnormalMarketLocally(data, abnormalInfo) {
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const atr = safeNumber(data.atr_points ?? data.atr, 0);

  if (spread > 65 || abnormalInfo.reasons.length >= 3 || atr > 700) {
    return {
      verdict: "ABNORMAL_SKIP",
      confidence: 88,
      reason_code: "ABNORMAL_VOLATILITY_BLOCK",
    };
  }

  return {
    verdict: "ABNORMAL_REDUCE_RISK",
    confidence: 76,
    reason_code: "ABNORMAL_RISK_TRIM",
  };
}

function buildStrategyNotesLocally(trades, buckets, global) {
  const boostBuckets = buckets
    .filter((b) => b.total >= 3 && b.win_rate >= 60 && b.avg_rr > 0)
    .slice(0, 5)
    .map((b) => ({
      bucket: b.key,
      adjustment: b.win_rate >= 70 ? 0.04 : 0.02,
      risk_multiplier: b.win_rate >= 70 ? 1.05 : 1,
      reason: "Recent bucket performance is constructive but still risk-aware.",
    }));

  const avoidBuckets = buckets
    .filter((b) => b.total >= 3 && b.win_rate <= 40 && b.avg_rr <= 0)
    .slice(0, 5)
    .map((b) => ({
      bucket: b.key,
      adjustment: b.win_rate <= 30 ? -0.12 : -0.08,
      risk_multiplier: b.win_rate <= 30 ? 0.55 : 0.7,
      reason: "Recent bucket is underperforming and should be de-risked.",
    }));

  const sessionMap = trades.reduce((acc, trade) => {
    const session = String(trade.learned_context?.session || "NA").toUpperCase();
    if (!acc[session]) acc[session] = { total: 0, pnl: 0 };
    acc[session].total += 1;
    acc[session].pnl += safeNumber(trade.pnl, 0);
    return acc;
  }, {});

  const sessionBias = {};
  for (const [session, stats] of Object.entries(sessionMap)) {
    if (stats.total < 2) continue;
    const avgPnl = stats.pnl / stats.total;
    sessionBias[session] = round2(clamp(avgPnl / 100, -0.05, 0.05));
  }

  const notes = [
    `Protect capital first: total=${global.total || 0}, wins=${global.wins || 0}, losses=${global.losses || 0}.`,
    "Prefer trend pullback setups with tight spread and entries closer to EMA20.",
    "Reduce risk or skip when the market is extended, climactic, or spread widens.",
  ];

  return {
    notes,
    boost_buckets: boostBuckets,
    avoid_buckets: avoidBuckets,
    session_bias: sessionBias,
    confidence_adjustments: [
      {
        type: "stretch_penalty",
        min_stretch_ratio: 0.75,
        adjustment: -0.08,
        risk_multiplier: 0.8,
      },
    ],
  };
}

// =========================
// GPT 调用
// =========================
function cleanModelJsonText(text) {
  const raw = String(text || "").trim();

  if (!raw) throw new Error("Empty model response");

  // 尝试去掉 markdown code fence
  if (raw.startsWith("```")) {
    const cleaned = raw
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();
    return cleaned;
  }

  return raw;
}

async function callModel(modelUsed, data) {
  if (!hasLiveModelAccess()) {
    return buildProfessionalDecision(data);
  }

  const completion = await client.chat.completions.create({
    model: modelUsed,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a disciplined professional intraday trader for an MT5 EA. Use only trend-following pullback logic, protect capital first, and avoid emotional or overextended entries. Prefer BUY only when bullish trend bias and setup align; prefer SELL only when bearish trend bias and setup align. Skip when spread is wide, ATR is too low, the move is already extended away from EMA20, a candle looks climactic, or the edge is unclear. Keep risk_percent conservative between 0.25 and 0.5 for valid trades and 0 for skips. Maintain a minimum target reward-to-risk of 1.6, prefer 1.8-2.2 when quality is better. Return JSON only with keys: action, confidence, reason_code, sl_points, tp_points, risk_percent. action must be BUY, SELL, or SKIP. confidence must be 0-100. Do not add explanation outside JSON.",
      },
      {
        role: "user",
        content: JSON.stringify(data),
      },
    ],
  });

  const text = cleanModelJsonText(
    completion.choices?.[0]?.message?.content || "",
  );
  const result = JSON.parse(text);

  return {
    action: String(result.action || "SKIP").toUpperCase(),
    confidence: toEaConfidence(result.confidence ?? 0),
    reason_code: String(result.reason_code || "GPT_DECISION"),
    sl_points: safeNumber(result.sl_points, 0),
    tp_points: safeNumber(result.tp_points, 0),
    risk_percent: safeNumber(result.risk_percent, 0),
  };
}

async function callAbnormalReviewModel(modelUsed, data, abnormalInfo) {
  if (!hasLiveModelAccess()) {
    return reviewAbnormalMarketLocally(data, abnormalInfo);
  }

  const completion = await client.chat.completions.create({
    model: modelUsed,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an abnormal market review filter. Return JSON only with keys: verdict, confidence, reason_code. verdict must be ABNORMAL_SKIP, ABNORMAL_OK, or ABNORMAL_REDUCE_RISK.",
      },
      {
        role: "user",
        content: JSON.stringify({
          data,
          abnormalInfo,
        }),
      },
    ],
  });

  const text = cleanModelJsonText(
    completion.choices?.[0]?.message?.content || "",
  );
  const result = JSON.parse(text);

  return {
    verdict: String(result.verdict || "ABNORMAL_SKIP").toUpperCase(),
    confidence: toEaConfidence(result.confidence ?? 0),
    reason_code: String(result.reason_code || "ABNORMAL_REVIEW"),
  };
}

// =========================
// 响应构造
// =========================
function buildDecisionResponse({
  tradeId,
  routeTier,
  action,
  confidence,
  reasonCode,
  slPoints = 0,
  tpPoints = 0,
  riskPercent = 0,
  source,
  model,
}) {
  return {
    trade_id: tradeId,
    route_tier: routeTier,
    action: String(action || "SKIP").toUpperCase(),
    confidence: toEaConfidence(confidence),
    reason_code: reasonCode || "NA",
    sl_points: round2(slPoints),
    tp_points: round2(tpPoints),
    risk_percent: round2(riskPercent),
    source: String(source || "LOCAL").toUpperCase(),
    model: String(model || "LOCAL").toUpperCase(),
  };
}

function buildRiskPlan(data, learn, strategy, reviewedResult) {
  const quality = computeEntryQualityMetrics(data);
  let confidencePenalty = 0;
  let riskMultiplier = clamp(
    Number(strategy?.riskMultiplier ?? 1),
    0.25,
    1.2,
  );

  if (quality.mildlyExtended) {
    confidencePenalty += 4;
    riskMultiplier *= 0.9;
  }
  if (quality.stretched) {
    confidencePenalty += 9;
    riskMultiplier *= 0.75;
  }
  if (quality.climactic) {
    confidencePenalty += 12;
    riskMultiplier *= 0.65;
  } else if (quality.impulsive) {
    confidencePenalty += 6;
    riskMultiplier *= 0.82;
  }

  if (learn?.stats?.total >= 4 && learn?.stats?.winRate < 0.35 && learn?.stats?.avgRR < 0) {
    confidencePenalty += 6;
    riskMultiplier *= 0.72;
  }
  if (learn?.stats?.total >= 8 && learn?.stats?.winRate < 0.4 && learn?.stats?.avgRR <= 0) {
    confidencePenalty += 8;
    riskMultiplier *= 0.7;
  }

  const adjustedRisk = round2(
    clamp(safeNumber(reviewedResult?.risk_percent, 0.28) * riskMultiplier, 0.12, 0.5),
  );

  return {
    confidencePenalty,
    riskPercent: adjustedRisk,
    riskMultiplier: clamp(riskMultiplier, 0.25, 1.2),
  };
}

// =========================
// Health
// =========================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    method: "GET",
    time: nowIso(),
    cheap_model: CHEAP_MODEL,
    primary_model: PRIMARY_MODEL,
    simulation_mode: SIMULATION_MODE,
  });
});

app.post("/health", (req, res) => {
  res.json({
    status: "ok",
    method: "POST",
    time: nowIso(),
    cheap_model: CHEAP_MODEL,
    primary_model: PRIMARY_MODEL,
    simulation_mode: SIMULATION_MODE,
  });
});

// =========================
// 决策主路由
// =========================

function shouldPrimaryReview({ modelResult, learn }) {
  const action = String(modelResult.action || "SKIP").toUpperCase();
  const conf = safeNumber(modelResult.confidence, 0);
  const total = learn?.stats?.total || 0;
  const winRate = learn?.stats?.winRate || 0;
  const note = String(learn?.note || "");

  if (action !== "BUY" && action !== "SELL") return false;

  if (conf >= PRIMARY_REVIEW_MIN_CONF && conf <= PRIMARY_REVIEW_MAX_CONF)
    return true;
  if (total < 5) return true;
  if (winRate >= 0.45 && winRate <= 0.55) return true;
  if (note === "NO_HISTORY" || note === "NEUTRAL_BUCKET") return true;

  return false;
}

app.post("/decision", async (req, res) => {
  if (!authOk(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const data = req.body || {};
  const tradeId = makeTradeId();

  const baseScore = localScore(data);
  const learn = learningAdjustments(data, baseScore);
  const strategy = applyStrategyNotesAdjustment(data, learn.learnedScore);
  const finalLocalScore = strategy.scoreAfterStrategy;

  logHeader("NEW DECISION REQUEST");
  console.log("trade_id:", tradeId);
  console.log("symbol:", data.symbol);
  console.log("timeframe:", data.timeframe);
  console.log("trend:", data.trend);
  console.log("trend_bias:", data.trend_bias);
  console.log("setup_tag:", data.setup_tag);
  console.log("session:", data.session);
  console.log("rsi:", data.rsi);
  console.log("atr_points:", data.atr_points ?? data.atr);
  console.log("spread_points:", data.spread_points ?? data.spread);
  console.log("base_score:", round2(baseScore));
  console.log("learning_adj:", round2(learn.scoreAdj), "|", learn.note);
  console.log("final_local_score:", round2(finalLocalScore));
  console.log("bucket_key:", learn.bucketKey);
  logJson("bucket_stats:", learn.stats);

  // 1) 学习硬拦截
  if (learn.skip) {
    const response = buildDecisionResponse({
      tradeId,
      routeTier: "LEARNING_BLOCK",
      action: "SKIP",
      confidence: 35,
      reasonCode: "BAD_HISTORICAL_BUCKET",
      source: "LEARNING",
      model: "LOCAL",
    });

    printDecisionSummary({
      tradeId,
      data,
      baseScore,
      learn,
      finalLocalScore,
      routeTier: response.route_tier,
      apiCalled: false,
      modelUsed: "LOCAL",
      response,
      strategy,
    });
    return res.json(response);
  }

  // 2) 低分直接跳过，不打 API
  if (finalLocalScore < 0.36) {
    const response = buildDecisionResponse({
      tradeId,
      routeTier: "LOCAL_FILTER",
      action: "SKIP",
      confidence: finalLocalScore * 100,
      reasonCode:
        learn.note === "WEAK_BUCKET" || learn.note === "BAD_BUCKET"
          ? "LOW_SCORE_WEAK_HISTORY"
          : "LOW_LOCAL_SCORE",
      source: "LOCAL_FILTER",
      model: "LOCAL",
    });

    printDecisionSummary({
      tradeId,
      data,
      baseScore,
      learn,
      finalLocalScore,
      routeTier: response.route_tier,
      apiCalled: false,
      modelUsed: "LOCAL",
      response,
      strategy,
    });
    return res.json(response);
  }

  // 3) 很高分直接本地放行，不打 API
  const allowLocalBypass =
    finalLocalScore >= 0.88 &&
    (learn.stats.total < 6 ||
      (learn.stats.winRate >= 0.55 && learn.stats.avgRR > 0));

  if (allowLocalBypass) {
    const localDecision = buildProfessionalDecision(data);
    const riskPlan = buildRiskPlan(data, learn, strategy, localDecision);
    const localConfidence = clamp(
      Math.max(safeNumber(localDecision.confidence, 0), finalLocalScore * 100) -
        riskPlan.confidencePenalty,
      0,
      100,
    );
    const localAction =
      localDecision.action !== "SKIP" && localConfidence >= 72
        ? localDecision.action
        : "SKIP";

    const response = buildDecisionResponse({
      tradeId,
      routeTier: "LOCAL_HIGH_CONF",
      action: localAction,
      confidence: localConfidence,
      reasonCode:
        localAction === "SKIP"
          ? localDecision.reason_code || "LOCAL_HIGH_CONF_SKIP"
          : localDecision.reason_code || "HIGH_LOCAL_SCORE",
      slPoints: localAction === "SKIP" ? 0 : localDecision.sl_points,
      tpPoints: localAction === "SKIP" ? 0 : localDecision.tp_points,
      riskPercent: localAction === "SKIP" ? 0 : riskPlan.riskPercent,
      source: "LOCAL_HIGH_CONF",
      model: "LOCAL",
    });

    if (response.action === "BUY" || response.action === "SELL") {
      savePendingDecision(tradeId, buildSnapshotForLearning(data, response));
    }

    printDecisionSummary({
      tradeId,
      data,
      baseScore,
      learn,
      finalLocalScore,
      routeTier: response.route_tier,
      apiCalled: false,
      modelUsed: "LOCAL",
      response,
      strategy,
    });
    return res.json(response);
  }

  // 4) 中间区域才调模型
  const cheapBudgetCheck = canUseApiCall("cheap");
  if (!cheapBudgetCheck.ok) {
    const response = buildDecisionResponse({
      tradeId,
      routeTier:
        cheapBudgetCheck.reason === "MONTHLY_BUDGET_REACHED"
          ? "MONTHLY_BUDGET_BLOCK"
          : "DAILY_BUDGET_BLOCK",
      action: "SKIP",
      confidence: finalLocalScore * 100,
      reasonCode:
        cheapBudgetCheck.reason === "MONTHLY_BUDGET_REACHED"
          ? "MONTHLY_API_BUDGET_REACHED"
          : "DAILY_API_LIMIT_REACHED",
      source: "LOCAL",
      model: "LOCAL",
    });

    printDecisionSummary({
      tradeId,
      data,
      baseScore,
      learn,
      strategy,
      finalLocalScore,
      routeTier: response.route_tier,
      apiCalled: false,
      modelUsed: "LOCAL",
      response,
    });

    return res.json(response);
  }

  let modelUsed = CHEAP_MODEL;
  let routeTier = "CHEAP_MODEL";

  const bucketTotal = learn.stats.total || 0;
  const bucketWinRate = learn.stats.winRate || 0;

  // 只有接近可交易阈值又不够稳，才上主模型
  if (finalLocalScore >= 0.69 && (bucketTotal < 5 || bucketWinRate < 0.5)) {
    modelUsed = PRIMARY_MODEL;
    routeTier = "PRIMARY_MODEL";
  }

  printModelCall(modelUsed, routeTier, tradeId);

  try {
    const initialCallType = modelUsed === PRIMARY_MODEL ? "primary" : "cheap";
    registerApiCall(initialCallType);
    const modelResult = await callModel(modelUsed, data);

    let reviewedResult = modelResult;
    let finalRouteTier = routeTier;
    let finalModelUsed = modelUsed;

    if (
      modelUsed === CHEAP_MODEL &&
      shouldPrimaryReview({ modelResult, learn }) &&
      canUseApiCall("primary").ok
    ) {
      console.log("[REVIEW] primary review triggered");

      registerApiCall("primary");

      const primaryResult = await callModel(PRIMARY_MODEL, data);

      console.log(
        `[PRIMARY] action=${primaryResult.action} conf=${primaryResult.confidence} reason=${primaryResult.reason_code}`,
      );

      // 规则：只有 primary 更明确时才覆盖 cheap
      if (
        (primaryResult.action === modelResult.action &&
          primaryResult.confidence >= modelResult.confidence) ||
        (primaryResult.action !== "SKIP" && primaryResult.confidence >= 80)
      ) {
        reviewedResult = primaryResult;
        finalRouteTier = "PRIMARY_REVIEW";
        finalModelUsed = PRIMARY_MODEL;
      }
    }

    const riskPlan = buildRiskPlan(data, learn, strategy, reviewedResult);
    let adjustedConfidence = clamp(
      safeNumber(reviewedResult.confidence, 0) +
        learn.scoreAdj * 100 +
        strategy.strategyAdj * 100 -
        riskPlan.confidencePenalty,
      0,
      100,
    );

    let finalAction = reviewedResult.action;
    if (adjustedConfidence < 68) {
      finalAction = "SKIP";
    }

    const abnormalInfo = detectAbnormalMarket(data);

    if (finalAction !== "SKIP" && abnormalInfo.abnormal) {
      const abnormalBudgetCheck = canUseApiCall("abnormal");
      if (!abnormalBudgetCheck.ok) {
        console.log(
          `[ABNORMAL] skipped review due to ${abnormalBudgetCheck.reason}`,
        );
      } else {
        console.log(
          `[ABNORMAL] triggered=${abnormalInfo.abnormal} reasons=${abnormalInfo.reasons.join(",")}`,
        );

        registerApiCall("abnormal");

        const abnormalReview = await callAbnormalReviewModel(
          PRIMARY_MODEL,
          data,
          abnormalInfo,
        );

        console.log(
          `[ABNORMAL_REVIEW] verdict=${abnormalReview.verdict} conf=${abnormalReview.confidence} reason=${abnormalReview.reason_code}`,
        );

        if (abnormalReview.verdict === "ABNORMAL_SKIP") {
          finalAction = "SKIP";
          adjustedConfidence = Math.min(adjustedConfidence, 65);
          finalRouteTier = "ABNORMAL_BLOCK";
          finalModelUsed = PRIMARY_MODEL;
        } else if (abnormalReview.verdict === "ABNORMAL_REDUCE_RISK") {
          reviewedResult.risk_percent = Math.max(
            0.1,
            safeNumber(reviewedResult.risk_percent, 0.35) * 0.5,
          );
          finalRouteTier = "ABNORMAL_REDUCE_RISK";
          finalModelUsed = PRIMARY_MODEL;
        }
      }
    }

    // 历史差 setup 即使模型给了 BUY/SELL，也压低
    if (learn.stats.total >= 10 && learn.stats.winRate < 0.35) {
      adjustedConfidence = Math.min(adjustedConfidence, 67);
    }

    if (adjustedConfidence < 68) {
      finalAction = "SKIP";
    }

    const response = buildDecisionResponse({
      tradeId,
      action: finalAction,
      confidence: adjustedConfidence,
      reasonCode: reviewedResult.reason_code || "GPT_DECISION",
      slPoints: reviewedResult.sl_points,
      tpPoints: reviewedResult.tp_points,
      riskPercent:
        finalAction === "SKIP" ? 0 : riskPlan.riskPercent,
      routeTier: finalRouteTier,
      source: decisionSourceLabel(),
      model: decisionModelLabel(finalModelUsed),
    });

    if (response.action === "BUY" || response.action === "SELL") {
      savePendingDecision(tradeId, buildSnapshotForLearning(data, response));
    }

    printDecisionSummary({
      tradeId,
      data,
      baseScore,
      learn,
      finalLocalScore,
      routeTier: response.route_tier,
      apiCalled: true,
      modelUsed: finalModelUsed,
      response,
      strategy,
    });
    return res.json(response);
  } catch (err) {
    console.log("Model error:", err?.message || err);

    const response = buildDecisionResponse({
      tradeId,
      routeTier,
      action: "SKIP",
      confidence: 50,
      reasonCode: "ERROR_FALLBACK",
      source: "ERROR",
      model: modelUsed,
    });

    printDecisionSummary({
      tradeId,
      data,
      baseScore,
      learn,
      finalLocalScore,
      routeTier: response.route_tier,
      apiCalled: true,
      modelUsed,
      response,
      strategy,
    });
    return res.json(response);
  }
});

// =========================
// 平仓结果 -> 学习
// =========================

async function refreshStrategyNotesIfNeeded() {
  const trades = loadTrades();
  if (trades.length < 10)
    return { updated: false, reason: "NOT_ENOUGH_TRADES" };
  if (trades.length % 10 !== 0)
    return { updated: false, reason: "NOT_TRIGGER_POINT" };

  const learning = loadLearning();
  const buckets = Object.values(learning.buckets || {})
    .map((b) => ({
      key: b.key,
      total: b.total || 0,
      win_rate: b.total > 0 ? round2((b.wins / b.total) * 100) : 0,
      avg_rr: b.total > 0 ? round2(b.rr_sum / b.total) : 0,
      avg_pnl: b.total > 0 ? round2(b.pnl_sum / b.total) : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  let result;
  const summaryBudgetCheck = canUseApiCall("summary");

  if (hasLiveModelAccess() && summaryBudgetCheck.ok) {
    registerApiCall("summary");

    const completion = await client.chat.completions.create({
      model: PRIMARY_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are maintaining concise professional trading notes for an MT5 AI filter. Return JSON only with keys: notes, boost_buckets, avoid_buckets, session_bias, confidence_adjustments. boost_buckets and avoid_buckets must be arrays of objects with bucket, adjustment, risk_multiplier, reason. confidence_adjustments must be an array of objects. Keep outputs short, risk-aware, and practical.",
        },
        {
          role: "user",
          content: JSON.stringify({
            recent_trades: trades.slice(-20),
            top_buckets: buckets,
            global: learning.global,
          }),
        },
      ],
    });

    const text = cleanModelJsonText(
      completion.choices?.[0]?.message?.content || "",
    );
    result = JSON.parse(text);
  } else {
    result = buildStrategyNotesLocally(trades.slice(-20), buckets, learning.global);
  }

  const payload = {
    updated_at: nowIso(),
    notes: Array.isArray(result.notes) ? result.notes : [],
    boost_buckets: Array.isArray(result.boost_buckets)
      ? result.boost_buckets
      : [],
    avoid_buckets: Array.isArray(result.avoid_buckets)
      ? result.avoid_buckets
      : [],
    session_bias:
      typeof result.session_bias === "object" && result.session_bias
        ? result.session_bias
        : {},
    confidence_adjustments:
      Array.isArray(result.confidence_adjustments) &&
      result.confidence_adjustments
        ? result.confidence_adjustments
        : [],
  };

  saveStrategyNotes(payload);
  return { updated: true, reason: "STRATEGY_NOTES_REFRESHED", notes: payload };
}

app.post("/trade-result", async (req, res) => {
  if (!authOk(req)) {
    console.log("TRADE-RESULT UNAUTHORIZED");
    return res.status(403).json({ error: "Unauthorized" });
  }

  const trade = req.body || {};
  const tradeId = String(trade.trade_id || "");
  const pendingMeta = consumePendingDecision(tradeId);

  logHeader("TRADE RESULT RECEIVED");
  console.log("trade_id:", tradeId);
  console.log("result:", trade.result);
  console.log("pnl:", trade.pnl);
  console.log("rr_result:", trade.rr_result);
  console.log("close_reason:", trade.close_reason);
  console.log("holding_minutes:", trade.holding_minutes);

  saveTrade({
    ...trade,
    learned_context: pendingMeta || null,
    saved_at: nowIso(),
  });

  const learning = updateLearningFromTrade(trade, pendingMeta);

  printLearningSummary({
    trade,
    learning,
    pendingMeta,
  });

  try {
    const refresh = await refreshStrategyNotesIfNeeded();
    console.log(
      `[STRATEGY_NOTES] updated=${refresh.updated} reason=${refresh.reason}`,
    );
  } catch (err) {
    console.log(`[STRATEGY_NOTES] error=${err?.message || err}`);
  }

  return res.json({ ok: true });
});

// =========================
// 启动
// =========================
const server = app.listen(PORT, () => {
  printHealthStartup();
  printStartupSnapshot();
});

app.get("/learning-status", (req, res) => {
  const learning = loadLearning();
  const buckets = Object.values(learning.buckets || {});

  const topBuckets = buckets
    .filter((b) => (b.total || 0) >= 3)
    .sort((a, b) => {
      const aw = a.total > 0 ? a.wins / a.total : 0;
      const bw = b.total > 0 ? b.wins / b.total : 0;
      return bw - aw;
    })
    .slice(0, 10)
    .map((b) => ({
      key: b.key,
      total: b.total,
      win_rate: b.total > 0 ? round2((b.wins / b.total) * 100) : 0,
      avg_rr: b.total > 0 ? round2(b.rr_sum / b.total) : 0,
      avg_pnl: b.total > 0 ? round2(b.pnl_sum / b.total) : 0,
    }));

  res.json({
    global: learning.global,
    top_buckets: topBuckets,
    updated_at: learning.updated_at,
  });
});

app.get("/usage-status", (req, res) => {
  const usage = loadUsageState();
  res.json({
    budget_usd: MONTHLY_BUDGET_USD,
    base_target_usd: BASE_MONTHLY_TARGET_USD,
    remaining_budget_usd: round2(
      MONTHLY_BUDGET_USD - safeNumber(usage.month_estimated_cost_usd, 0),
    ),
    usage,
  });
});

app.get("/startup-status", (req, res) => {
  res.json(buildStartupSnapshot());
});

app.get("/strategy-notes", (req, res) => {
  const notes = loadStrategyNotes();
  res.json(notes);
});

export { app, server };
