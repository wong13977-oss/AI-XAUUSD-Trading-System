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
const PRIMARY_REVIEW_MIN_CONF = 66;
const PRIMARY_REVIEW_MAX_CONF = 78;

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

function safeRatio(numerator, denominator, fallback = 0) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return fallback;
  return n / d;
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

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

function normalizeConfidenceAdjustmentRule(rule) {
  if (!rule || typeof rule !== "object") return null;

  if (rule.type === "stretch_penalty") {
    return {
      type: "stretch_penalty",
      min_stretch_ratio: round2(Math.max(0.4, Number(rule.min_stretch_ratio ?? 0.75))),
      adjustment: normalizeBucketAdjustmentValue(rule.adjustment, -0.08),
      risk_multiplier: clamp(Number(rule.risk_multiplier ?? 0.8), 0.25, 1),
    };
  }

  if (rule.type === "session_setup_penalty") {
    return {
      type: "session_setup_penalty",
      session: rule.session ? String(rule.session).toUpperCase() : "",
      setup_tag: rule.setup_tag ? String(rule.setup_tag).toUpperCase() : "",
      trend_bias: rule.trend_bias ? String(rule.trend_bias).toUpperCase() : "",
      adjustment: normalizeBucketAdjustmentValue(rule.adjustment, -0.06),
      risk_multiplier: clamp(Number(rule.risk_multiplier ?? 0.8), 0.25, 1),
    };
  }

  if (rule.type === "weak_bucket_penalty") {
    return {
      type: "weak_bucket_penalty",
      min_total: Math.max(0, Number(rule.min_total ?? 3)),
      max_win_rate: clamp(Number(rule.max_win_rate ?? 0.45), 0, 1),
      max_avg_rr: Number(rule.max_avg_rr ?? 0),
      adjustment: normalizeBucketAdjustmentValue(rule.adjustment, -0.08),
      risk_multiplier: clamp(Number(rule.risk_multiplier ?? 0.5), 0.25, 1),
    };
  }

  const text = String(rule.rule || rule.note || rule.reason || "")
    .trim()
    .toLowerCase();

  if (!text) return null;

  if (text.includes("newyork") && text.includes("pullback")) {
    return {
      type: "session_setup_penalty",
      session: "NEWYORK",
      setup_tag: "",
      trend_bias: "",
      adjustment: -0.12,
      risk_multiplier: 0.65,
    };
  }

  if (
    text.includes("ema20") ||
    text.includes("stretched") ||
    text.includes("impulse")
  ) {
    return {
      type: "stretch_penalty",
      min_stretch_ratio: 0.72,
      adjustment: -0.1,
      risk_multiplier: 0.72,
    };
  }

  if (text.includes("half-size") || text.includes("negative avg_rr")) {
    return {
      type: "weak_bucket_penalty",
      min_total: 3,
      max_win_rate: 0.45,
      max_avg_rr: 0,
      adjustment: -0.08,
      risk_multiplier: 0.5,
    };
  }

  return null;
}

function normalizeStrategyNotesPayload(notes) {
  const source = notes && typeof notes === "object" ? notes : {};
  const confidenceAdjustments = asArray(source.confidence_adjustments)
    .map((rule) => normalizeConfidenceAdjustmentRule(rule))
    .filter(Boolean);

  return {
    updated_at: String(source.updated_at || ""),
    notes: asArray(source.notes).map((note) => String(note || "")).filter(Boolean),
    boost_buckets: asArray(source.boost_buckets)
      .map((entry) => normalizeBucketRuleEntry(entry, 0.04))
      .filter(Boolean),
    avoid_buckets: asArray(source.avoid_buckets)
      .map((entry) => normalizeBucketRuleEntry(entry, -0.08))
      .filter(Boolean),
    session_bias:
      source.session_bias && typeof source.session_bias === "object"
        ? Object.fromEntries(
            Object.entries(source.session_bias).map(([key, value]) => [
              String(key).toUpperCase(),
              normalizeSessionBiasValue(value),
            ]),
          )
        : {},
    confidence_adjustments: confidenceAdjustments,
  };
}

function normalizeTradeRrResult(trade, pendingMeta = null) {
  const result = normalizeResultLabel(trade?.result);
  const raw = safeNumber(trade?.rr_result, 0);
  let normalized = raw;
  let repaired = false;

  if (Math.abs(normalized) > 6 && Math.abs(normalized) <= 600) {
    const scaled = normalized / 100;
    if (Math.abs(scaled) <= 6) {
      normalized = scaled;
      repaired = true;
    }
  }

  if (!Number.isFinite(normalized)) {
    normalized = 0;
    repaired = true;
  }

  if (result === "WIN" && normalized < 0) {
    normalized = Math.abs(normalized);
    repaired = true;
  }
  if (result === "LOSS" && normalized > 0) {
    normalized = -Math.abs(normalized);
    repaired = true;
  }
  if (result === "BREAKEVEN" && Math.abs(normalized) > 0.25) {
    normalized = 0;
    repaired = true;
  }

  const slPoints = safeNumber(pendingMeta?.sl_points, 0);
  const tpPoints = safeNumber(pendingMeta?.tp_points, 0);
  const impliedTargetRr = tpPoints > 0 && slPoints > 0 ? safeRatio(tpPoints, slPoints, 0) : 0;
  const rrCap = clamp(
    impliedTargetRr > 0 ? Math.max(2.5, impliedTargetRr * 1.4) : 3,
    2.5,
    4,
  );

  const clipped = clamp(normalized, -2.5, rrCap);
  if (clipped !== normalized) repaired = true;

  return {
    raw: round2(raw),
    normalized: round2(clipped),
    repaired,
  };
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
    farExtended: stretchRatio >= 1.1,
    stretched: stretchRatio >= 0.88,
    mildlyExtended: stretchRatio >= 0.65,
    climactic: rangeRatio >= 1.2 && bodyShare >= 0.72,
    impulsive: rangeRatio >= 0.95 && bodyRatio >= 0.55,
  };
}

function isWeakLearningNote(note) {
  return [
    "EARLY_WEAK_BUCKET",
    "WEAK_BUCKET",
    "BAD_BUCKET",
    "HARD_BLOCK_BAD_BUCKET",
  ].includes(String(note || "").toUpperCase());
}

function isPreferredSession(session) {
  const normalized = normalizeSession(session);
  return normalized === "LONDON" || normalized === "NEWYORK";
}

function buildExecutionScaleMetrics(data, quality = computeEntryQualityMetrics(data)) {
  const atr = Math.max(quality.atr, 1);
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const legacyScale = atr < 700;
  const spreadRatio = safeRatio(spread, atr, 1);

  return {
    atr,
    spread,
    legacyScale,
    spreadRatio,
    spreadTight: legacyScale ? spread <= 22 : spreadRatio <= 0.012,
    spreadOk: legacyScale ? spread <= 35 : spreadRatio <= 0.02,
    spreadWide: legacyScale ? spread > 45 : spreadRatio > 0.03,
    spreadTooWide: legacyScale ? spread > 55 : spreadRatio > 0.03 || spread > 55,
    atrTradable: legacyScale ? atr >= 130 : atr >= 700,
    atrOptimal: legacyScale
      ? atr >= 160 && atr <= 420
      : atr >= 900 && atr <= 2800,
  };
}

function signed(n) {
  const x = safeNumber(n, 0);
  return x > 0 ? `+${round2(x)}` : `${round2(x)}`;
}

function line(char = "-") {
  console.log(char.repeat(70));
}

function scoreTag(score) {
  const n = safeNumber(score, 0);
  if (n >= 0.82) return "A";
  if (n >= 0.68) return "B";
  if (n >= 0.54) return "C";
  return "D";
}

function buildDecisionReasons(data, learn, strategy, finalLocalScore, response) {
  const quality = computeEntryQualityMetrics(data);
  const reasons = [];
  const session = normalizeSession(data.session);
  const setup = normalizeSetupTag(data.setup_tag);
  const trendBias = normalizeTrendBias(data.trend_bias);
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const atr = Math.max(1, safeNumber(data.atr_points ?? data.atr, 0));
  const spreadRatio = safeRatio(spread, atr, 0);

  if (["BULL", "BEAR"].includes(trendBias) && setup.includes(trendBias === "BULL" ? "BUY" : "SELL")) {
    reasons.push(`trend ${trendBias}`);
  }
  if (isPreferredSession(session)) reasons.push(`session ${session}`);
  if (strategy?.strategyAdj > 0) reasons.push(`strategy ${signed(strategy.strategyAdj)}`);
  if (learn?.scoreAdj > 0) reasons.push(`learning ${signed(learn.scoreAdj)}`);
  if (spreadRatio > 0 && spreadRatio <= 0.018) reasons.push(`spread ${round2(spreadRatio * 100)}% ATR`);
  if (quality.stretchRatio >= 0.12 && quality.stretchRatio <= 0.52 && setup.includes("PULLBACK")) {
    reasons.push(`pullback ${round2(quality.stretchRatio)} ATR`);
  }
  if (quality.rangeRatio <= 0.95 && quality.bodyShare >= 0.28 && quality.bodyShare <= 0.68) {
    reasons.push(`calm bar ${round2(quality.rangeRatio)} ATR`);
  }
  if (safeNumber(finalLocalScore, 0) < 0.54) reasons.push("below entry threshold");
  if (strategy?.strategyAdj < 0) reasons.push(`strategy ${signed(strategy.strategyAdj)}`);
  if (learn?.scoreAdj < 0) reasons.push(`learning ${signed(learn.scoreAdj)}`);
  if (quality.stretched || quality.farExtended) reasons.push(`extended ${round2(quality.stretchRatio)} ATR`);
  if (quality.climactic || quality.rangeRatio > 1.2 || quality.bodyShare > 0.72) {
    reasons.push(`impulse r=${round2(quality.rangeRatio)} b=${round2(quality.bodyShare)}`);
  }
  if (response?.reason_code) reasons.push(`${response.reason_code}`);

  return reasons.slice(0, 5);
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
  const reasons = buildDecisionReasons(
    data,
    learn,
    strategy,
    finalLocalScore,
    response,
  );

  line("=");
  console.log(`📌 Decision | ${String(data.symbol || "").toUpperCase()} ${String(data.timeframe || "").toUpperCase()} | ${String(data.session || "").toUpperCase()} | ${String(data.setup_tag || "").toUpperCase()}`);
  console.log(`🧭 Context  | trend=${String(data.trend_bias || data.trend || "").toUpperCase()} | trade_id=${tradeId}`);
  console.log(`📊 Score    | base=${round2(baseScore)} | learn=${signed(learn?.scoreAdj || 0)} | strat=${signed(strategy?.strategyAdj || 0)} | final=${round2(finalLocalScore)} | grade=${scoreTag(finalLocalScore)}`);
  console.log(`🧠 Learn    | note=${learn?.note || "NA"} | bucket=${bucketTotal} | win=${pct(bucketWinRate)} | rr=${round2(bucketAvgRR)} | pnl=${round2(bucketAvgPnl)}`);
  console.log(`🛣 Route    | ${routeTier} | api=${apiCalled ? "YES" : "NO"} | model=${modelUsed || "LOCAL"} | strategy=${strategy?.strategyNote || "NA"}`);
  console.log(`🎯 Final    | action=${response.action} | conf=${response.confidence} | risk=${response.risk_percent}% | sl=${response.sl_points} | tp=${response.tp_points}`);
  console.log(`📝 Why      | ${reasons.join(" | ")}`);
  line("=");
}

function printLearningSummary({ trade, learning, pendingMeta }) {
  const total = learning.global.total || 0;
  const wins = learning.global.wins || 0;
  const winRate = total > 0 ? wins / total : 0;
  const avgRR = total > 0 ? learning.global.rr_sum / total : 0;
  const avgPnl = total > 0 ? learning.global.pnl_sum / total : 0;

  line("=");
  console.log(`📚 Result   | trade_id=${trade.trade_id || "NA"} | ${trade.result || "NA"} | pnl=${round2(trade.pnl)} | rr=${round2(trade.rr_result)} | close=${trade.close_reason || "NA"}`);
  console.log(`🌍 Global   | total=${total} | win=${pct(winRate)} | rr=${round2(avgRR)} | pnl=${round2(avgPnl)}`);

  if (pendingMeta?.bucket_key) {
    const bucket = learning.buckets[pendingMeta.bucket_key];
    const bucketStats = getBucketStats(bucket);

    console.log(`🪣 Bucket   | ${pendingMeta.bucket_key} | total=${bucketStats.total} | win=${pct(bucketStats.winRate)} | rr=${round2(bucketStats.avgRR)} | pnl=${round2(bucketStats.avgPnl)}`);
  } else {
    console.log(`🪣 Bucket   | no pending context matched`);
  }

  line("=");
}

function printModelCall(modelUsed, routeTier, tradeId) {
  console.log(`🤖 Model    | calling=${modelUsed} | route=${routeTier} | trade_id=${tradeId}`);
}

function printUsageSummary(usage) {
  const remainingBudget = round2(
    MONTHLY_BUDGET_USD - safeNumber(usage?.month_estimated_cost_usd, 0),
  );

  console.log(`💸 Usage    | month=${usage?.month_calls || 0} | day=${usage?.day_calls || 0} | cost=$${round2(usage?.month_estimated_cost_usd || 0)} | left=$${remainingBudget}`);
  console.log(`💸 Mix      | cheap=${usage?.cheap_calls || 0} | primary=${usage?.primary_calls || 0} | summary=${usage?.summary_calls || 0} | abnormal=${usage?.abnormal_calls || 0}`);
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
  return safeReadJson(LEARNING_FILE, createEmptyLearningState());
}

function saveLearning(learning) {
  learning.updated_at = nowIso();
  safeWriteJson(LEARNING_FILE, learning);
}

function loadStrategyNotes() {
  return normalizeStrategyNotesPayload(
    safeReadJson(STRATEGY_NOTES_FILE, {
      updated_at: "",
      notes: [],
      boost_buckets: [],
      avoid_buckets: [],
      session_bias: {},
      confidence_adjustments: [],
    }),
  );
}

function loadRawStrategyNotes() {
  return safeReadJson(STRATEGY_NOTES_FILE, {
    updated_at: "",
    notes: [],
    boost_buckets: [],
    avoid_buckets: [],
    session_bias: {},
    confidence_adjustments: [],
  });
}

function saveStrategyNotes(data) {
  safeWriteJson(STRATEGY_NOTES_FILE, normalizeStrategyNotesPayload(data));
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

function createEmptyLearningState() {
  return {
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
  const rr = normalizeTradeRrResult(trade, pendingMeta).normalized;
  const holdingMinutes = safeNumber(trade.holding_minutes, 0);

  updateGlobalStats(learning, result, pnl, rr, holdingMinutes);

  if (pendingMeta && pendingMeta.bucket_key) {
    const bucket = ensureBucket(learning, pendingMeta.bucket_key);
    updateBucketStats(bucket, pendingMeta, result, pnl, rr, holdingMinutes);
  }

  saveLearning(learning);
  return learning;
}

function rebuildLearningFromTrades(trades) {
  const learning = createEmptyLearningState();

  for (const trade of asArray(trades)) {
    const pendingMeta =
      trade?.learned_context && typeof trade.learned_context === "object"
        ? trade.learned_context
        : null;
    const result = normalizeResultLabel(trade.result);
    const pnl = safeNumber(trade.pnl, 0);
    const rr = normalizeTradeRrResult(trade, pendingMeta).normalized;
    const holdingMinutes = safeNumber(trade.holding_minutes, 0);

    updateGlobalStats(learning, result, pnl, rr, holdingMinutes);

    if (pendingMeta?.bucket_key) {
      const bucket = ensureBucket(learning, pendingMeta.bucket_key);
      updateBucketStats(bucket, pendingMeta, result, pnl, rr, holdingMinutes);
    }
  }

  learning.updated_at = nowIso();
  return learning;
}

function repairStateFiles() {
  const storedTrades = loadTrades();
  const normalizedTrades = asArray(storedTrades).map((trade) => {
    const pendingMeta =
      trade?.learned_context && typeof trade.learned_context === "object"
        ? {
            ...trade.learned_context,
            sl_points: safeNumber(trade.learned_context.sl_points, 0),
            tp_points: safeNumber(trade.learned_context.tp_points, 0),
            risk_percent: safeNumber(trade.learned_context.risk_percent, 0),
          }
        : null;
    const rrMeta = normalizeTradeRrResult(trade, pendingMeta);

    return {
      ...trade,
      learned_context: pendingMeta,
      rr_result: rrMeta.normalized,
      rr_result_raw:
        rrMeta.repaired || trade?.rr_result_raw == null
          ? rrMeta.raw
          : safeNumber(trade.rr_result_raw, rrMeta.raw),
      rr_result_repaired: rrMeta.repaired,
    };
  });

  if (!deepEqual(storedTrades, normalizedTrades)) {
    safeWriteJson(TRADES_FILE, normalizedTrades);
    console.log("[REPAIR] normalized stored trade outcomes");
  }

  const rebuiltLearning = rebuildLearningFromTrades(normalizedTrades);
  const storedLearning = safeReadJson(LEARNING_FILE, createEmptyLearningState());
  rebuiltLearning.created_at = String(
    storedLearning.created_at || rebuiltLearning.created_at,
  );
  const comparableStoredLearning = {
    ...storedLearning,
    updated_at: "",
  };
  const comparableRebuiltLearning = {
    ...rebuiltLearning,
    updated_at: "",
  };
  if (!deepEqual(comparableStoredLearning, comparableRebuiltLearning)) {
    saveLearning(rebuiltLearning);
    console.log("[REPAIR] rebuilt learning state from normalized trades");
  }

  const rawNotes = loadRawStrategyNotes();
  const normalizedNotes = normalizeStrategyNotesPayload(rawNotes);
  if (!deepEqual(rawNotes, normalizedNotes)) {
    saveStrategyNotes(normalizedNotes);
    console.log("[REPAIR] normalized strategy notes structure");
  }
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
    sl_points: safeNumber(response.sl_points, 0),
    tp_points: safeNumber(response.tp_points, 0),
    risk_percent: safeNumber(response.risk_percent, 0),
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
  const session = normalizeSession(data.session);

  const rsi = safeNumber(data.rsi, 0);
  const atrPoints = safeNumber(data.atr_points ?? data.atr, 0);
  const spread = safeNumber(data.spread_points ?? data.spread, 999);
  const quality = computeEntryQualityMetrics(data);
  const execution = buildExecutionScaleMetrics(data, quality);
  const pullbackWindowOk =
    quality.stretchRatio >= 0.12 && quality.stretchRatio <= 0.52;
  const continuationWindowOk = quality.stretchRatio <= 0.32;
  const candleBalanced =
    quality.rangeRatio >= 0.18 &&
    quality.rangeRatio <= 0.95 &&
    quality.bodyShare >= 0.28 &&
    quality.bodyShare <= 0.68;

  const body1 = safeNumber(data.body1_points, 0);
  const range1 = safeNumber(data.range1_points, 0);

  const hasPosition = data.has_position === true;
  const positionType = String(data.position_type || "").toUpperCase();
  const positionCount = safeNumber(data.position_count, hasPosition ? 1 : 0);
  const maxScaleInPositions = clamp(
    safeNumber(data.max_scale_in_positions, 3),
    1,
    10,
  );
  const newsBlocked = data.news_blocked === true;
  const dailyLossHit = data.daily_loss_hit === true;
  const actionBias = pickDirectionalAction(data);
  const sameDirectionScaleIn =
    hasPosition &&
    ["BUY", "SELL"].includes(actionBias) &&
    positionType === actionBias &&
    positionCount < maxScaleInPositions;

  if ((trend === "up" || trendBias === "BULL") && rsi >= 50) score += 0.18;
  if ((trend === "down" || trendBias === "BEAR") && rsi <= 50) score += 0.18;

  if (setup.includes("BUY") && (trend === "up" || trendBias === "BULL"))
    score += 0.16;
  if (setup.includes("SELL") && (trend === "down" || trendBias === "BEAR"))
    score += 0.16;

  if (isPreferredSession(session)) score += 0.08;
  else if (session === "ASIA") score -= 0.05;

  if (execution.spreadTight) score += 0.14;
  else if (execution.spreadOk) score += 0.09;
  else if (!execution.spreadWide) score += 0.03;
  else score -= 0.12;

  if (setup.includes("PULLBACK")) {
    if (pullbackWindowOk) score += 0.16;
    else if (quality.stretchRatio <= 0.62) score += 0.08;
    else score -= 0.1;
  } else if (setup.includes("CONTINUATION")) {
    if (continuationWindowOk) score += 0.1;
    else if (quality.stretchRatio > 0.55) score -= 0.08;
  }

  if (candleBalanced) score += 0.09;
  else if (quality.rangeRatio > 1.2) score -= 0.14;
  else if (quality.rangeRatio > 1.05) score -= 0.08;
  else if (body1 >= 0 && range1 >= 0 && (body1 > 0 || range1 > 0)) score += 0.03;
  if (quality.bodyShare > 0.72) score -= 0.1;
  else if (quality.bodyShare > 0.64) score -= 0.05;

  if (execution.atrOptimal) score += 0.05;

  if (quality.mildlyExtended) score -= 0.05;
  if (quality.stretched) score -= 0.09;
  if (quality.farExtended) score -= 0.12;
  if (quality.climactic) score -= 0.14;
  else if (quality.impulsive) score -= 0.07;

  if (trendBias === "BULL" && setup.includes("BUY")) {
    if (rsi >= 52 && rsi <= 64) score += 0.1;
    else if (rsi > 72) score -= 0.12;
    else if (rsi < 48) score -= 0.08;
  }

  if (trendBias === "BEAR" && setup.includes("SELL")) {
    if (rsi >= 36 && rsi <= 48) score += 0.1;
    else if (rsi < 28) score -= 0.12;
    else if (rsi > 52) score -= 0.08;
  }

  if (hasPosition) score -= sameDirectionScaleIn ? 0.06 : 0.2;
  if (newsBlocked) score -= 0.4;
  if (dailyLossHit) score -= 0.5;

  return clamp(score, 0, 1);
}

function detectAbnormalMarket(data) {
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const quality = computeEntryQualityMetrics(data);
  const execution = buildExecutionScaleMetrics(data, quality);

  const reasons = [];

  if (execution.spreadTooWide) reasons.push("HIGH_SPREAD");
  if (quality.rangeRatio > 1.35) reasons.push("LARGE_RANGE_BAR");
  if (quality.stretchRatio > 1.05) reasons.push("FAR_FROM_EMA20");
  if (quality.climactic) reasons.push("CLIMACTIC_BAR");

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

  if (stats.total < 6) {
    if (stats.winRate <= 0.25 && stats.avgRR < -0.15) {
      scoreAdj -= 0.04;
      note = "EARLY_CAUTION_BUCKET";
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

  if (stats.total >= 12 && stats.winRate >= 0.62 && stats.avgRR > 0.18) {
    scoreAdj += 0.1;
    note = "GOOD_BUCKET";
  } else if (stats.total >= 8 && stats.winRate >= 0.56 && stats.avgRR >= 0.08) {
    scoreAdj += 0.05;
    note = "DECENT_BUCKET";
  } else if (stats.total >= 6 && stats.winRate < 0.34 && stats.avgRR < -0.12) {
    scoreAdj -= 0.05;
    note = "EARLY_WEAK_BUCKET";
  } else if (stats.total >= 10 && stats.winRate < 0.36 && stats.avgRR < -0.15) {
    scoreAdj -= 0.1;
    note = "WEAK_BUCKET";
  } else if (stats.total >= 14 && stats.winRate < 0.3 && stats.avgRR < -0.2) {
    scoreAdj -= 0.16;
    note = "BAD_BUCKET";
  } else {
    note = "NEUTRAL_BUCKET";
  }

  if (stats.total >= 16 && stats.winRate < 0.28 && stats.avgRR < -0.22) {
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

function applyStrategyNotesAdjustment(data, score, learn = null) {
  const notes = loadStrategyNotes();
  const bucketKey = buildBucketKey(data);

  let adj = 0;
  let riskMultiplier = 1;
  let note = "NO_STRATEGY_NOTE";
  const weakHistory = isWeakLearningNote(learn?.note);

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
    const overlapAdjustment = weakHistory
      ? Math.max(safeNumber(avoidRule.adjustment, -0.08), -0.04)
      : safeNumber(avoidRule.adjustment, -0.08);
    adj += overlapAdjustment;
    riskMultiplier *= weakHistory
      ? 0.9
      : Math.min(1, avoidRule.risk_multiplier || 0.75);
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

    if (rule.type === "weak_bucket_penalty") {
      if (weakHistory) continue;

      const stats = learn?.stats || {};
      const minTotal = Number(rule.min_total ?? 3);
      const maxWinRate = Number(rule.max_win_rate ?? 0.45);
      const maxAvgRr = Number(rule.max_avg_rr ?? 0);

      if (
        safeNumber(stats.total, 0) >= minTotal &&
        safeNumber(stats.winRate, 0) <= maxWinRate &&
        safeNumber(stats.avgRR, 0) <= maxAvgRr
      ) {
        adj += normalizeBucketAdjustmentValue(rule.adjustment, -0.08);
        riskMultiplier *= clamp(Number(rule.risk_multiplier ?? 0.5), 0.25, 1);
        note = "WEAK_BUCKET_PENALTY";
      }
    }
  }

  return {
    strategyAdj: clamp(adj, -0.18, 0.12),
    riskMultiplier: clamp(riskMultiplier, 0.25, 1.2),
    strategyNote: note,
    scoreAfterStrategy: clamp(score + clamp(adj, -0.18, 0.12), 0, 1),
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

function buildDecisionContext(data, learn, strategy, finalLocalScore) {
  const quality = computeEntryQualityMetrics(data);
  const abnormal = detectAbnormalMarket(data);
  const notes = loadStrategyNotes();

  return {
    local: {
      final_score: round2(finalLocalScore),
      bucket_note: String(learn?.note || "NA"),
      bucket_stats: {
        total: safeNumber(learn?.stats?.total, 0),
        win_rate: round2(safeNumber(learn?.stats?.winRate, 0) * 100),
        avg_rr: round2(safeNumber(learn?.stats?.avgRR, 0)),
        avg_pnl: round2(safeNumber(learn?.stats?.avgPnl, 0)),
      },
    },
    quality: {
      stretch_ratio: round2(quality.stretchRatio),
      range_ratio: round2(quality.rangeRatio),
      body_ratio: round2(quality.bodyRatio),
      body_share: round2(quality.bodyShare),
      stretched: quality.stretched,
      climactic: quality.climactic,
      impulsive: quality.impulsive,
    },
    strategy: {
      adjustment: round2(strategy?.strategyAdj || 0),
      risk_multiplier: round2(strategy?.riskMultiplier || 1),
      note: String(strategy?.strategyNote || "NA"),
      session_bias: notes.session_bias?.[normalizeSession(data.session)] ?? 0,
      notes_preview: asArray(notes.notes).slice(0, 3),
    },
    abnormal_market: abnormal,
  };
}

function shouldAllowLocalBypass(data, learn, strategy, finalLocalScore) {
  const quality = computeEntryQualityMetrics(data);
  const abnormal = detectAbnormalMarket(data);
  const spread = safeNumber(data.spread_points ?? data.spread, 999);

  if (finalLocalScore < 0.72) return false;
  if (abnormal.abnormal) return false;
  if (strategy?.strategyAdj < -0.04) return false;
  if (spread > 30) return false;
  if (quality.farExtended) return false;
  if (quality.climactic) return false;
  if (quality.stretchRatio > 0.62) return false;
  if (quality.rangeRatio > 1.1) return false;

  return true;
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
  const session = normalizeSession(data.session);
  const spread = safeNumber(data.spread_points ?? data.spread, 0);
  const atr = safeNumber(data.atr_points ?? data.atr, 0);
  const rsi = safeNumber(data.rsi, 50);
  const body1 = safeNumber(data.body1_points, 0);
  const range1 = safeNumber(data.range1_points, 0);
  const closeToEma20 = safeNumber(data.close_to_ema20_points, 0);
  const hasPosition = data.has_position === true;
  const positionType = String(data.position_type || "").toUpperCase();
  const positionCount = safeNumber(data.position_count, hasPosition ? 1 : 0);
  const maxScaleInPositions = clamp(
    safeNumber(data.max_scale_in_positions, 3),
    1,
    10,
  );
  const strongScaleInMinConfidence = clamp(
    safeNumber(data.strong_scale_in_min_confidence, 82),
    60,
    99,
  );
  const newsBlocked = data.news_blocked === true;
  const dailyLossHit = data.daily_loss_hit === true;
  const setup = normalizeSetupTag(data.setup_tag);
  const trendBias = normalizeTrendBias(data.trend_bias);
  const quality = computeEntryQualityMetrics(data);
  const execution = buildExecutionScaleMetrics(data, quality);
  const pullbackWindowOk =
    quality.stretchRatio >= 0.1 && quality.stretchRatio <= 0.58;
  const continuationWindowOk = quality.stretchRatio <= 0.36;
  const balancedTrendBar =
    quality.rangeRatio >= 0.2 &&
    quality.rangeRatio <= 1.02 &&
    quality.bodyShare >= 0.28 &&
    quality.bodyShare <= 0.72;

  const sameDirectionScaleIn =
    hasPosition &&
    ["BUY", "SELL"].includes(actionBias) &&
    positionType === actionBias &&
    positionCount < maxScaleInPositions;

  if (hasPosition && !sameDirectionScaleIn) {
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

  if (
    execution.spreadTooWide ||
    (session === "ASIA" && !execution.legacyScale && execution.spreadRatio > 0.02)
  ) {
    return {
      action: "SKIP",
      confidence: 34,
      reason_code:
        session === "ASIA" && spread > 35
          ? "PRO_ASIA_SPREAD_TOO_WIDE"
          : "PRO_SPREAD_TOO_WIDE",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (!execution.atrTradable) {
    return {
      action: "SKIP",
      confidence: 36,
      reason_code: "PRO_RANGE_TOO_SMALL",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (quality.climactic || (range1 >= atr * 1.2 && body1 >= range1 * 0.72)) {
    return {
      action: "SKIP",
      confidence: 44,
      reason_code: "PRO_CLIMACTIC_BAR_SKIP",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (closeToEma20 >= atr * 1.05 || (quality.farExtended && quality.impulsive)) {
    return {
      action: "SKIP",
      confidence: 46,
      reason_code: "PRO_CHASE_EXTENSION_SKIP",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (session === "ASIA" && !balancedTrendBar) {
    return {
      action: "SKIP",
      confidence: 42,
      reason_code: "PRO_LOW_LIQUIDITY_SESSION",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  let confidence = 62;

  if (isPreferredSession(session)) confidence += 5;
  else if (session === "ASIA") confidence -= 4;

  if (setup.includes("PULLBACK")) {
    confidence += 6;
    if (pullbackWindowOk) confidence += 8;
    else if (quality.stretchRatio > 0.7) confidence -= 8;
  } else if (setup.includes("CONTINUATION")) {
    confidence += 4;
    if (continuationWindowOk) confidence += 5;
  }

  if (execution.spreadTight) confidence += 7;
  else if (execution.spreadOk) confidence += 4;
  else if (execution.spreadWide) confidence -= 8;

  if (balancedTrendBar) confidence += 6;
  else if (quality.rangeRatio > 1.2) confidence -= 10;
  else if (quality.rangeRatio > 1.1) confidence -= 5;
  if (quality.bodyShare > 0.72) confidence -= 8;
  else if (quality.bodyShare > 0.64) confidence -= 4;
  if (execution.atrOptimal) confidence += 4;
  if (quality.stretched) confidence -= 8;
  else if (quality.mildlyExtended) confidence -= 3;
  if (quality.farExtended) confidence -= 6;
  else if (closeToEma20 >= atr * 0.88) confidence -= 3;
  if (quality.impulsive) confidence -= 6;

  if (actionBias === "BUY") {
    if (trendBias === "BULL") confidence += 4;
    if (rsi >= 52 && rsi <= 64) confidence += 6;
    else if (rsi > 75) confidence -= 12;
    else if (rsi < 46) confidence -= 7;
  }

  if (actionBias === "SELL") {
    if (trendBias === "BEAR") confidence += 4;
    if (rsi <= 48 && rsi >= 36) confidence += 6;
    else if (rsi < 25) confidence -= 12;
    else if (rsi > 54) confidence -= 7;
  }

  confidence = clamp(confidence, 48, 95);

  const slPoints = round2(clamp(atr * 0.92, 130, 950));
  const rrTarget =
    confidence >= 82 ? 2.1 : confidence >= 76 ? 1.9 : confidence >= 70 ? 1.75 : 1.6;
  const tpPoints = round2(slPoints * rrTarget);
  let riskPercent =
    confidence >= 82 ? 0.36 : confidence >= 76 ? 0.3 : 0.22;
  if (setup.includes("CONTINUATION")) riskPercent *= 0.95;
  if (session === "ASIA") riskPercent *= 0.9;
  riskPercent = round2(riskPercent);

  if (confidence < 63) {
    return {
      action: "SKIP",
      confidence,
      reason_code: "PRO_EDGE_BELOW_THRESHOLD",
      sl_points: 0,
      tp_points: 0,
      risk_percent: 0,
    };
  }

  if (sameDirectionScaleIn && confidence < strongScaleInMinConfidence) {
    return {
      action: "SKIP",
      confidence,
      reason_code: "SCALE_IN_SIGNAL_NOT_STRONG",
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

  if (spread > 70 || abnormalInfo.reasons.length >= 4 || atr > 900) {
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

function isHardSkipReason(reasonCode) {
  const reason = String(reasonCode || "").toUpperCase();
  return [
    "POSITION_ALREADY_OPEN",
    "NEWS_RISK_BLOCK",
    "DAILY_LOSS_BLOCK",
    "NO_DIRECTIONAL_EDGE",
    "PRO_SPREAD_TOO_WIDE",
    "PRO_ASIA_SPREAD_TOO_WIDE",
    "PRO_RANGE_TOO_SMALL",
    "PRO_CLIMACTIC_BAR_SKIP",
    "PRO_CHASE_EXTENSION_SKIP",
    "ABNORMAL_VOLATILITY_BLOCK",
    "BAD_HISTORICAL_BUCKET",
  ].some((token) => reason.includes(token));
}

function shouldConvertModelSkipToTrade({
  modelResult,
  localDecision,
  data,
  finalLocalScore,
}) {
  if (String(modelResult?.action || "").toUpperCase() !== "SKIP") return false;
  if (!["BUY", "SELL"].includes(String(localDecision?.action || "").toUpperCase()))
    return false;
  if (safeNumber(localDecision?.confidence, 0) < 68) return false;
  if (isHardSkipReason(modelResult?.reason_code)) return false;
  const positionType = String(data.position_type || "").toUpperCase();
  const positionCount = safeNumber(data.position_count, data.has_position === true ? 1 : 0);
  const maxScaleInPositions = clamp(
    safeNumber(data.max_scale_in_positions, 3),
    1,
    10,
  );
  const sameDirectionScaleIn =
    data.has_position === true &&
    ["BUY", "SELL"].includes(String(localDecision?.action || "").toUpperCase()) &&
    positionType === String(localDecision?.action || "").toUpperCase() &&
    positionCount < maxScaleInPositions;

  if ((!sameDirectionScaleIn && data.has_position === true) || data.news_blocked === true || data.daily_loss_hit === true)
    return false;

  const spread = safeNumber(data.spread_points ?? data.spread, 999);
  const atr = safeNumber(data.atr_points ?? data.atr, 0);
  if (spread > 40 || atr < 90) return false;
  if (safeNumber(finalLocalScore, 0) < 0.52) return false;

  return true;
}

function buildConservativeDirectionalFallback(localDecision, finalLocalScore, modelReason) {
  const confidence = round2(
    clamp(
      Math.max(
        safeNumber(localDecision?.confidence, 0) - 6,
        safeNumber(finalLocalScore, 0) * 100 - 4,
      ),
      62,
      86,
    ),
  );

  return {
    action: String(localDecision?.action || "SKIP").toUpperCase(),
    confidence,
    reason_code: `SMART_FALLBACK_${String(modelReason || localDecision?.reason_code || "DIRECTIONAL").toUpperCase()}`,
    sl_points: safeNumber(localDecision?.sl_points, 0),
    tp_points: safeNumber(localDecision?.tp_points, 0),
    risk_percent: round2(
      clamp(safeNumber(localDecision?.risk_percent, 0.22) * 0.85, 0.16, 0.3),
    ),
  };
}

function buildStrategyNotesLocally(trades, buckets, global) {
  const boostBuckets = buckets
    .filter((b) => b.total >= 6 && b.win_rate >= 60 && b.avg_rr > 0.12)
    .slice(0, 5)
    .map((b) => ({
      bucket: b.key,
      adjustment: b.win_rate >= 68 ? 0.03 : 0.02,
      risk_multiplier: b.win_rate >= 68 ? 1.04 : 1,
      reason: "Recent bucket expectancy is constructive and still sample-aware.",
    }));

  const avoidBuckets = buckets
    .filter((b) => b.total >= 6 && b.win_rate <= 35 && b.avg_rr < -0.12)
    .slice(0, 5)
    .map((b) => ({
      bucket: b.key,
      adjustment: b.win_rate <= 25 ? -0.08 : -0.05,
      risk_multiplier: b.win_rate <= 25 ? 0.75 : 0.85,
      reason: "Recent bucket is underperforming, so size should be reduced before blocking it.",
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
    if (stats.total < 4) continue;
    const avgPnl = stats.pnl / stats.total;
    sessionBias[session] = round2(clamp(avgPnl / 250, -0.03, 0.03));
  }

  const notes = [
    `Protect capital first: total=${global.total || 0}, wins=${global.wins || 0}, losses=${global.losses || 0}.`,
    "Prefer London and New York trend-pullback trades only when spread is efficient versus ATR and the pullback stays close to EMA20.",
    "Treat early losing samples as reduced size, not immediate hard bans; wait for stronger evidence before disabling a bucket.",
  ];

  return {
    notes,
    boost_buckets: boostBuckets,
    avoid_buckets: avoidBuckets,
    session_bias: sessionBias,
    confidence_adjustments: [
      {
        type: "stretch_penalty",
        min_stretch_ratio: 0.7,
        adjustment: -0.06,
        risk_multiplier: 0.85,
      },
      {
        type: "weak_bucket_penalty",
        min_total: 8,
        max_win_rate: 0.36,
        max_avg_rr: -0.1,
        adjustment: -0.05,
        risk_multiplier: 0.82,
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

async function callModel(modelUsed, data, context = {}) {
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
    "You are a disciplined professional intraday trader for an MT5 EA. Your job is to decide when an entry should be taken, not to over-filter every setup. Use trend-following pullback logic and calm continuation logic, protect capital first, and avoid emotional or overextended entries. Prefer BUY only when bullish trend bias and setup align; prefer SELL only when bearish trend bias and setup align. Use SKIP only for clear hard blocks such as very wide spread, very low ATR, no directional edge, daily loss lock, or truly abnormal volatility. Treat an open position as a hard block only when it is opposite direction, mixed exposure, or already at the scale-in cap. If the local context already shows a credible trend setup, prefer a lower-confidence BUY or SELL over SKIP unless a hard block exists. Do not skip merely because ATR is elevated or price is somewhat away from EMA20 if the trend structure is still intact; instead lower confidence and risk. Be extra selective in Asia session unless spread is tight and trend structure is clean. Keep risk_percent conservative between 0.18 and 0.4 for valid trades and 0 for skips. Maintain a minimum target reward-to-risk of 1.6, prefer 1.8-2.2 when quality is better. Return JSON only with keys: action, confidence, reason_code, sl_points, tp_points, risk_percent. action must be BUY, SELL, or SKIP. confidence must be 0-100. Do not add explanation outside JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          market_snapshot: data,
          server_context: context,
        }),
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

async function callAbnormalReviewModel(modelUsed, data, abnormalInfo, context = {}) {
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
          context,
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
    confidencePenalty += 3;
    riskMultiplier *= 0.9;
  }
  if (quality.stretched) {
    confidencePenalty += 5;
    riskMultiplier *= 0.82;
  }
  if (quality.climactic) {
    confidencePenalty += 10;
    riskMultiplier *= 0.72;
  } else if (quality.impulsive) {
    confidencePenalty += 5;
    riskMultiplier *= 0.86;
  }

  if (learn?.stats?.total >= 4 && learn?.stats?.winRate < 0.35 && learn?.stats?.avgRR < 0) {
    confidencePenalty += 4;
    riskMultiplier *= 0.78;
  }
  if (learn?.stats?.total >= 8 && learn?.stats?.winRate < 0.4 && learn?.stats?.avgRR <= 0) {
    confidencePenalty += 6;
    riskMultiplier *= 0.75;
  }

  const adjustedRisk = round2(
    clamp(safeNumber(reviewedResult?.risk_percent, 0.26) * riskMultiplier, 0.12, 0.36),
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
  if (conf >= 82) return false;
  if (total < 4 && conf < 82) return true;
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
  const strategy = applyStrategyNotesAdjustment(data, learn.learnedScore, learn);
  const finalLocalScore = strategy.scoreAfterStrategy;
  const decisionContext = buildDecisionContext(
    data,
    learn,
    strategy,
    finalLocalScore,
  );

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
  if (finalLocalScore < 0.32) {
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
  const localDecision = buildProfessionalDecision(data);
  const localRiskPlan = buildRiskPlan(data, learn, strategy, localDecision);
  const localConfidence = clamp(
    Math.max(safeNumber(localDecision.confidence, 0), finalLocalScore * 100) -
      localRiskPlan.confidencePenalty,
    0,
    100,
  );

  if (localDecision.action === "SKIP" && finalLocalScore < 0.58) {
    const response = buildDecisionResponse({
      tradeId,
      routeTier: "LOCAL_DECISION_SKIP",
      action: "SKIP",
      confidence: localConfidence,
      reasonCode: localDecision.reason_code || "LOCAL_SKIP",
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

  if (
    localDecision.action !== "SKIP" &&
    localConfidence >= 63 &&
    finalLocalScore >= 0.5 &&
    !detectAbnormalMarket(data).abnormal
  ) {
    const response = buildDecisionResponse({
      tradeId,
      routeTier: "LOCAL_DIRECT",
      action: localDecision.action,
      confidence: localConfidence,
      reasonCode: localDecision.reason_code || "LOCAL_DIRECT",
      slPoints: localDecision.sl_points,
      tpPoints: localDecision.tp_points,
      riskPercent: localRiskPlan.riskPercent,
      source: "LOCAL_DIRECT",
      model: "LOCAL",
    });

    savePendingDecision(tradeId, buildSnapshotForLearning(data, response));

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

  const allowLocalBypass = shouldAllowLocalBypass(
    data,
    learn,
    strategy,
    finalLocalScore,
  );

  if (allowLocalBypass) {
    const localAction =
      localDecision.action !== "SKIP" && localConfidence >= 69
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
      riskPercent: localAction === "SKIP" ? 0 : localRiskPlan.riskPercent,
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
  if (
    finalLocalScore >= 0.58 &&
    finalLocalScore < 0.78 &&
    (bucketTotal < 5 || bucketWinRate < 0.5)
  ) {
    modelUsed = PRIMARY_MODEL;
    routeTier = "PRIMARY_MODEL";
  }

  printModelCall(modelUsed, routeTier, tradeId);

  try {
    const initialCallType = modelUsed === PRIMARY_MODEL ? "primary" : "cheap";
    registerApiCall(initialCallType);
    const modelResult = await callModel(modelUsed, data, decisionContext);

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

      const primaryResult = await callModel(PRIMARY_MODEL, data, decisionContext);

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

    if (
      shouldConvertModelSkipToTrade({
        modelResult: reviewedResult,
        localDecision,
        data,
        finalLocalScore,
      })
    ) {
      reviewedResult = buildConservativeDirectionalFallback(
        localDecision,
        finalLocalScore,
        reviewedResult.reason_code,
      );
      finalRouteTier = "SMART_FALLBACK";
      finalModelUsed = "LOCAL";
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
    if (adjustedConfidence < 63) {
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
          decisionContext,
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
            safeNumber(reviewedResult.risk_percent, 0.32) * 0.65,
          );
          finalRouteTier = "ABNORMAL_REDUCE_RISK";
          finalModelUsed = PRIMARY_MODEL;
        }
      }
    }

    // 历史差 setup 即使模型给了 BUY/SELL，也压低
    if (learn.stats.total >= 10 && learn.stats.winRate < 0.35) {
      adjustedConfidence = Math.min(adjustedConfidence, 62);
    }

    if (adjustedConfidence < 63) {
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
            "You are maintaining concise professional trading notes for an MT5 AI filter. Return JSON only with keys: notes, boost_buckets, avoid_buckets, session_bias, confidence_adjustments. boost_buckets and avoid_buckets must be arrays of objects with bucket, adjustment, risk_multiplier, reason. confidence_adjustments must be structured rule objects only. Allowed confidence_adjustments types: stretch_penalty {type,min_stretch_ratio,adjustment,risk_multiplier}, session_setup_penalty {type,session,setup_tag,trend_bias,adjustment,risk_multiplier}, weak_bucket_penalty {type,min_total,max_win_rate,max_avg_rr,adjustment,risk_multiplier}. Keep outputs short, risk-aware, and practical.",
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

  const rrMeta = normalizeTradeRrResult(trade, pendingMeta);
  const normalizedTrade = {
    ...trade,
    rr_result: rrMeta.normalized,
    rr_result_raw: rrMeta.raw,
    rr_result_repaired: rrMeta.repaired,
  };

  saveTrade({
    ...normalizedTrade,
    learned_context: pendingMeta || null,
    saved_at: nowIso(),
  });

  const learning = updateLearningFromTrade(normalizedTrade, pendingMeta);

  printLearningSummary({
    trade: normalizedTrade,
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
repairStateFiles();

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
