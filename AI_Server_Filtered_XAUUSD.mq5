#property strict

#include <Trade/Trade.mqh>

CTrade trade;

// =====================================================
// Inputs
// =====================================================
input string InpServerUrl                = "http://127.0.0.1:3000/decision";
input string InpTradeResultUrl           = "http://127.0.0.1:3000/trade-result";
input string InpHealthUrl                = "http://127.0.0.1:3000/health";
input string InpApiSecret                = "CHANGE_YOURS";
input string InpSymbol                   = "XAUUSD";
input ENUM_TIMEFRAMES InpTF              = PERIOD_M15;

input int    InpMagic                    = 26032026;
input double InpFixedLot                 = 0.01;
input bool   InpUseDynamicLot            = false;
input double InpRiskPercentFallback      = 0.35;

input int    InpFastEMA                  = 9;
input int    InpSlowEMA                  = 21;
input int    InpEMA20Period              = 20;
input int    InpRSIPeriod                = 14;
input int    InpATRPeriod                = 14;

input int    InpMaxSpreadPoints          = 100;
input int    InpMinATRPoints             = 130;
input int    InpMinConfidence            = 70;
input int    InpCooldownBars             = 1;
input bool   InpOnePositionOnly          = true;
input bool   InpAllowBuy                 = true;
input bool   InpAllowSell                = true;
input bool   InpEnablePreFilter          = true;
input bool   InpEnableServerReview       = true;
input bool   InpOnlyNewBarDecision       = true;

// =====================================================
// Session filter
// =====================================================
input bool   InpUseSessionFilter         = true;
input bool   InpUseLondonSession         = true;
input int    InpLondonStartHour          = 7;
input int    InpLondonEndHour            = 12;
input bool   InpUseNewYorkSession        = true;
input int    InpNewYorkStartHour         = 13;
input int    InpNewYorkEndHour           = 18;

// =====================================================
// News placeholder
// =====================================================
input bool   InpUseNewsFilter            = false;
input int    InpNewsBlockBeforeMin       = 30;
input int    InpNewsBlockAfterMin        = 30;

// =====================================================
// Trailing stop / partial
// =====================================================
input bool   InpUseEMA20Trailing         = true;
input bool   InpUseATRTrailing           = true;
input double InpATRTrailMult             = 1.80;
input double InpTrailActivateRR          = 0.80;
input bool   InpTrailAfterPartialOnly    = false;

input bool   InpUsePartialTP             = true;
input double InpPartialTP_RR             = 1.25;
input double InpPartialClosePercent      = 35.0;
input bool   InpMoveSLToBEAfterPart      = true;

// =====================================================
// Daily max loss
// =====================================================
input bool   InpUseDailyMaxLoss          = true;
input double InpDailyMaxLossAmount       = 80.0;
input bool   InpClosePositionsAtLimit    = false;

// =====================================================
// Misc
// =====================================================
input int    InpDeviationPoints          = 20;
input bool   InpPrintDebug               = false;
input bool   InpPrintDecisionSummary     = true;

// =====================================================
// Globals
// =====================================================
datetime g_lastBarTime = 0;
datetime g_lastTradeBarTime = 0;

datetime g_lastHealthCheck = 0;
string   g_lastHealth = "UNKNOWN";

int hFastEMA = INVALID_HANDLE;
int hSlowEMA = INVALID_HANDLE;
int hEMA20   = INVALID_HANDLE;
int hRSI     = INVALID_HANDLE;
int hATR     = INVALID_HANDLE;

string g_lastDecisionTradeId   = "";
string g_lastDecisionAction    = "";
string g_lastDecisionTier      = "";
string g_lastDecisionReason    = "";
string g_lastDecisionSource    = "";
string g_lastDecisionModel     = "";
double g_lastDecisionSLPoints  = 0.0;
double g_lastDecisionTPPoints  = 0.0;
double g_lastDecisionRiskPct   = 0.0;

string   g_lastLogText = "";
datetime g_lastLogTime = 0;

// =====================================================
// Logging
// =====================================================
void DebugPrint(string msg, bool force=false)
{
   if(!InpPrintDebug && !force)
      return;

   if(!force && msg == g_lastLogText && (TimeCurrent() - g_lastLogTime) < 3)
      return;

   g_lastLogText = msg;
   g_lastLogTime = TimeCurrent();
   Print("[AI-EA-V2] ", msg);
}

void InfoPrint(string msg)
{
   Print("[AI-EA-V2] ", msg);
}

// =====================================================
// Utility
// =====================================================
double SafePoint()
{
   double p = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);
   if(p <= 0.0) p = _Point;
   return p;
}

double NormalizePrice(double price)
{
   return NormalizeDouble(price, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS));
}

double NormalizeLot(double lot)
{
   double minLot  = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MAX);
   double stepLot = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_STEP);

   if(stepLot <= 0.0) stepLot = 0.01;

   lot = MathMax(minLot, MathMin(maxLot, lot));
   lot = MathFloor(lot / stepLot) * stepLot;

   int volDigits = 2;
   if(stepLot == 1.0) volDigits = 0;
   else if(stepLot == 0.1) volDigits = 1;
   else if(stepLot == 0.01) volDigits = 2;
   else if(stepLot == 0.001) volDigits = 3;

   return NormalizeDouble(lot, volDigits);
}

double CalcMoneyPerPointPerLot()
{
   double tickValue = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_SIZE);
   double point     = SafePoint();

   if(tickValue <= 0.0 || tickSize <= 0.0 || point <= 0.0)
      return 0.0;

   return tickValue * (point / tickSize);
}

double CalcLotByRisk(double sl_points, double risk_percent)
{
   if(sl_points <= 0.0)
      return NormalizeLot(InpFixedLot);

   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = balance * (risk_percent / 100.0);
   double moneyPerPointPerLot = CalcMoneyPerPointPerLot();

   if(moneyPerPointPerLot <= 0.0)
      return NormalizeLot(InpFixedLot);

   double lot = riskMoney / (sl_points * moneyPerPointPerLot);
   return NormalizeLot(lot);
}

bool IsNewBar()
{
   datetime currentBar = iTime(InpSymbol, InpTF, 0);
   if(currentBar == 0) return false;

   if(currentBar != g_lastBarTime)
   {
      g_lastBarTime = currentBar;
      return true;
   }
   return false;
}

bool InCooldown()
{
   if(g_lastTradeBarTime == 0) return false;

   int shiftLastTrade = iBarShift(InpSymbol, InpTF, g_lastTradeBarTime, false);
   if(shiftLastTrade < 0) return false;

   return (shiftLastTrade <= InpCooldownBars);
}

string EscapeJson(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", "");
   StringReplace(s, "\n", " ");
   return s;
}

bool ReadBufferValue(int handle, int shift, double &val)
{
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(handle, 0, shift, 1, buf) < 1)
      return false;
   val = buf[0];
   return true;
}

string BuildCandlesJson(int count = 12)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);

   int copied = CopyRates(InpSymbol, InpTF, 1, count, rates);
   if(copied <= 0) return "[]";

   string out = "[";
   for(int i = copied - 1; i >= 0; i--)
   {
      out += StringFormat(
         "{\"o\":%.2f,\"h\":%.2f,\"l\":%.2f,\"c\":%.2f}",
         rates[i].open, rates[i].high, rates[i].low, rates[i].close
      );
      if(i > 0) out += ",";
   }
   out += "]";
   return out;
}

string TFToText(ENUM_TIMEFRAMES tf)
{
   return EnumToString(tf);
}

string GetSessionName()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int hour = dt.hour;

   if(hour >= 0 && hour < 7)   return "ASIA";
   if(hour >= 7 && hour < 13)  return "LONDON";
   if(hour >= 13 && hour < 22) return "NEWYORK";
   return "OFF";
}

bool IsHourInRange(int hourNow, int startHour, int endHour)
{
   if(startHour <= endHour)
      return (hourNow >= startHour && hourNow < endHour);
   return (hourNow >= startHour || hourNow < endHour);
}

bool IsTradingSessionAllowed()
{
   if(!InpUseSessionFilter)
      return true;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int hourNow = dt.hour;

   bool londonOk = false;
   bool nyOk = false;

   if(InpUseLondonSession)
      londonOk = IsHourInRange(hourNow, InpLondonStartHour, InpLondonEndHour);
   if(InpUseNewYorkSession)
      nyOk = IsHourInRange(hourNow, InpNewYorkStartHour, InpNewYorkEndHour);

   return (londonOk || nyOk);
}

bool IsNewsBlockedNow()
{
   if(!InpUseNewsFilter)
      return false;
   return false;
}

// =====================================================
// Position helpers
// =====================================================
bool HasOpenPosition(string symbol)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;

      if(PositionGetString(POSITION_SYMBOL) == symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return true;
   }
   return false;
}

int GetPositionType(string symbol)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;

      if(PositionGetString(POSITION_SYMBOL) == symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return (int)PositionGetInteger(POSITION_TYPE);
   }
   return -1;
}

bool GetMyPosition(ulong &ticket, long &positionId, int &type, double &openPrice, double &sl, double &tp, double &volume, string &comment)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t <= 0) continue;
      if(!PositionSelectByTicket(t)) continue;

      if(PositionGetString(POSITION_SYMBOL) == InpSymbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
      {
         ticket     = t;
         positionId = PositionGetInteger(POSITION_IDENTIFIER);
         type       = (int)PositionGetInteger(POSITION_TYPE);
         openPrice  = PositionGetDouble(POSITION_PRICE_OPEN);
         sl         = PositionGetDouble(POSITION_SL);
         tp         = PositionGetDouble(POSITION_TP);
         volume     = PositionGetDouble(POSITION_VOLUME);
         comment    = PositionGetString(POSITION_COMMENT);
         return true;
      }
   }
   return false;
}

// =====================================================
// Global-variable state keys
// =====================================================
string KeyInitSL(long posId)      { return "AIV2_INITSL_" + IntegerToString((int)posId); }
string KeyPartial(long posId)     { return "AIV2_PARTIAL_" + IntegerToString((int)posId); }
string KeyEntryTime(long posId)   { return "AIV2_ENTRYTM_" + IntegerToString((int)posId); }
string KeyRiskMoney(long posId)   { return "AIV2_RISKMNY_" + IntegerToString((int)posId); }
string KeyClosedPnl(long posId)   { return "AIV2_CLSPNL_" + IntegerToString((int)posId); }
string KeyReported(long posId)    { return "AIV2_REPORTED_" + IntegerToString((int)posId); }

void SaveInitSL(long posId, double v)      { GlobalVariableSet(KeyInitSL(posId), v); }
double LoadInitSL(long posId)              { if(GlobalVariableCheck(KeyInitSL(posId))) return GlobalVariableGet(KeyInitSL(posId)); return 0.0; }
void SavePartialDone(long posId)           { GlobalVariableSet(KeyPartial(posId), 1.0); }
bool IsPartialDone(long posId)             { if(GlobalVariableCheck(KeyPartial(posId))) return (GlobalVariableGet(KeyPartial(posId)) > 0.5); return false; }
void SaveEntryTime(long posId, datetime t) { GlobalVariableSet(KeyEntryTime(posId), (double)t); }
datetime LoadEntryTime(long posId)         { if(GlobalVariableCheck(KeyEntryTime(posId))) return (datetime)(long)GlobalVariableGet(KeyEntryTime(posId)); return 0; }
void SaveRiskMoney(long posId, double v)   { GlobalVariableSet(KeyRiskMoney(posId), v); }
double LoadRiskMoney(long posId)           { if(GlobalVariableCheck(KeyRiskMoney(posId))) return GlobalVariableGet(KeyRiskMoney(posId)); return 0.0; }

void AddClosedPnl(long posId, double pnl)
{
   double cur = 0.0;
   if(GlobalVariableCheck(KeyClosedPnl(posId))) cur = GlobalVariableGet(KeyClosedPnl(posId));
   GlobalVariableSet(KeyClosedPnl(posId), cur + pnl);
}

double LoadClosedPnl(long posId)
{
   if(GlobalVariableCheck(KeyClosedPnl(posId))) return GlobalVariableGet(KeyClosedPnl(posId));
   return 0.0;
}

bool IsReported(long posId)
{
   if(GlobalVariableCheck(KeyReported(posId))) return (GlobalVariableGet(KeyReported(posId)) > 0.5);
   return false;
}

void MarkReported(long posId)
{
   GlobalVariableSet(KeyReported(posId), 1.0);
}

void CleanupTradeState(long posId)
{
   string keys[5] = { KeyInitSL(posId), KeyPartial(posId), KeyEntryTime(posId), KeyRiskMoney(posId), KeyClosedPnl(posId) };
   for(int i = 0; i < ArraySize(keys); i++)
      if(GlobalVariableCheck(keys[i])) GlobalVariableDel(keys[i]);
}

string TradeCommentWithId(string side, string tradeId)
{
   return side + "|" + tradeId;
}

string ExtractIdFromComment(string comment)
{
   int p = StringFind(comment, "|");
   if(p < 0) return "";
   return StringSubstr(comment, p + 1);
}

// =====================================================
// Daily loss control
// =====================================================
datetime GetStartOfDay(datetime t)
{
   MqlDateTime dt;
   TimeToStruct(t, dt);
   dt.hour = 0; dt.min = 0; dt.sec = 0;
   return StructToTime(dt);
}

double GetTodayClosedPL()
{
   datetime from = GetStartOfDay(TimeCurrent());
   datetime to   = TimeCurrent();
   if(!HistorySelect(from, to)) return 0.0;

   double total = 0.0;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;

      if(HistoryDealGetString(dealTicket, DEAL_SYMBOL) != InpSymbol) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != InpMagic) continue;

      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
      {
         total += HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
               +  HistoryDealGetDouble(dealTicket, DEAL_COMMISSION)
               +  HistoryDealGetDouble(dealTicket, DEAL_SWAP);
      }
   }
   return total;
}

double GetCurrentFloatingPL()
{
   double total = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;

      if(PositionGetString(POSITION_SYMBOL) == InpSymbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         total += PositionGetDouble(POSITION_PROFIT);
   }
   return total;
}

double GetTodayTotalPL()
{
   return GetTodayClosedPL() + GetCurrentFloatingPL();
}

bool DailyLossLimitHit()
{
   if(!InpUseDailyMaxLoss) return false;
   return (GetTodayTotalPL() <= -MathAbs(InpDailyMaxLossAmount));
}

void CloseMyPositions()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;

      if(PositionGetString(POSITION_SYMBOL) == InpSymbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         trade.PositionClose(ticket);
   }
}

void EnforceDailyLossLimit()
{
   if(!DailyLossLimitHit()) return;
   DebugPrint("Daily max loss hit", true);
   if(InpClosePositionsAtLimit) CloseMyPositions();
}

// =====================================================
// Signal compression / prefilter
// =====================================================
bool DetectTrendBias(string &bias, double emaFast, double emaSlow, double ema20, double close1)
{
   if(close1 > emaFast && emaFast > emaSlow && close1 > ema20)
   {
      bias = "BULL";
      return true;
   }
   if(close1 < emaFast && emaFast < emaSlow && close1 < ema20)
   {
      bias = "BEAR";
      return true;
   }
   bias = "NEUTRAL";
   return false;
}

bool DetectPullbackCandidate(string bias, double close1, double high1, double low1, double emaFast, double ema20, double atrPoints, string &setupTag)
{
   double touchTolerance = atrPoints * 0.24 * SafePoint();
   double closeTolerance = atrPoints * 0.40 * SafePoint();

   if(bias == "BULL")
   {
      if(low1 <= emaFast + touchTolerance || low1 <= ema20 + touchTolerance ||
         close1 <= emaFast + closeTolerance || close1 <= ema20 + closeTolerance)
      {
         setupTag = "TREND_PULLBACK_BUY";
         return true;
      }
   }
   else if(bias == "BEAR")
   {
      if(high1 >= emaFast - touchTolerance || high1 >= ema20 - touchTolerance ||
         close1 >= emaFast - closeTolerance || close1 >= ema20 - closeTolerance)
      {
         setupTag = "TREND_PULLBACK_SELL";
         return true;
      }
   }

   setupTag = "NONE";
   return false;
}

bool PreFilterPass(double spread_points, double atr_points, string bias, bool pullbackOk)
{
   if(!InpEnablePreFilter)
      return true;

   if(spread_points > InpMaxSpreadPoints)
   {
      DebugPrint("Skip: spread too high");
      return false;
   }
   if(atr_points < InpMinATRPoints)
   {
      DebugPrint("Skip: ATR too low");
      return false;
   }
   if(!IsTradingSessionAllowed())
   {
      DebugPrint("Skip: session filter");
      return false;
   }
   if(IsNewsBlockedNow())
   {
      DebugPrint("Skip: news filter");
      return false;
   }
   if(DailyLossLimitHit())
   {
      DebugPrint("Skip: daily loss limit");
      return false;
   }
   if(InpOnePositionOnly && HasOpenPosition(InpSymbol))
   {
      DebugPrint("Skip: already has position");
      return false;
   }
   if(InCooldown())
   {
      DebugPrint("Skip: cooldown");
      return false;
   }
   if(bias == "NEUTRAL")
   {
      DebugPrint("Skip: no clear trend bias");
      return false;
   }
   if(!pullbackOk)
   {
      DebugPrint("Skip: no pullback setup");
      return false;
   }
   return true;
}

// =====================================================
// JSON parsing helpers
// =====================================================
string JsonGetString(string json, string key)
{
   string pattern = "\"" + key + "\":";
   int pos = StringFind(json, pattern);
   if(pos < 0) return "";
   int start = StringFind(json, "\"", pos + StringLen(pattern));
   if(start < 0) return "";
   int end = StringFind(json, "\"", start + 1);
   if(end < 0) return "";
   return StringSubstr(json, start + 1, end - start - 1);
}

double JsonGetNumber(string json, string key)
{
   string pattern = "\"" + key + "\":";
   int pos = StringFind(json, pattern);
   if(pos < 0) return 0.0;
   int start = pos + StringLen(pattern);

   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '"') start++;
      else break;
   }

   int end = start;
   while(end < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, end);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-') end++;
      else break;
   }

   string num = StringSubstr(json, start, end - start);
   return StringToDouble(num);
}

string ParseDecisionObject(string response)
{
   int p = StringFind(response, "\"decision\":");
   if(p < 0) return response;
   int start = StringFind(response, "{", p);
   if(start < 0) return response;

   int depth = 0;
   for(int i = start; i < StringLen(response); i++)
   {
      ushort ch = StringGetCharacter(response, i);
      if(ch == '{') depth++;
      if(ch == '}')
      {
         depth--;
         if(depth == 0)
            return StringSubstr(response, start, i - start + 1);
      }
   }
   return response;
}

// =====================================================
// HTTP
// =====================================================
bool HttpPostJson(string url, string payload, string &responseText)
{
   string headers =
      "Content-Type: application/json\r\n"
      "x-api-secret: " + InpApiSecret + "\r\n";

   char postData[];
   char result[];
   string result_headers;

   StringToCharArray(payload, postData, 0, StringLen(payload), CP_UTF8);

   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, postData, result, result_headers);
   if(status == -1)
   {
      DebugPrint("WebRequest failed err=" + IntegerToString(GetLastError()), true);
      return false;
   }

   responseText = CharArrayToString(result, 0, -1, CP_UTF8);
   if(status < 200 || status >= 300)
   {
      DebugPrint("HTTP status=" + IntegerToString(status), true);
      return false;
   }
   return true;
}

bool HealthCheckServer()
{
   if(TimeCurrent() - g_lastHealthCheck < 300)
      return (g_lastHealth == "OK");

   g_lastHealthCheck = TimeCurrent();
   string payload = "{}";
   string response = "";
   bool ok = HttpPostJson(InpHealthUrl, payload, response);
   g_lastHealth = ok ? "OK" : "DOWN";
   return ok;
}

// =====================================================
// AI request
// =====================================================
bool RequestDecision(string &responseText)
{
   if(!InpEnableServerReview)
      return false;

   double emaFast, emaSlow, ema20, rsi, atr;
   if(!ReadBufferValue(hFastEMA, 1, emaFast)) return false;
   if(!ReadBufferValue(hSlowEMA, 1, emaSlow)) return false;
   if(!ReadBufferValue(hEMA20, 1, ema20))     return false;
   if(!ReadBufferValue(hRSI, 1, rsi))         return false;
   if(!ReadBufferValue(hATR, 1, atr))         return false;

   MqlRates rates[3];
   ArraySetAsSeries(rates, true);
   if(CopyRates(InpSymbol, InpTF, 1, 3, rates) < 3)
      return false;

   double bid           = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask           = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double point         = SafePoint();
   double spread_points = (ask - bid) / point;
   double atr_points    = atr / point;

   string bias = "NEUTRAL";
   DetectTrendBias(bias, emaFast, emaSlow, ema20, rates[0].close);

   string setupTag = "NONE";
   bool pullbackOk = DetectPullbackCandidate(bias, rates[0].close, rates[0].high, rates[0].low, emaFast, ema20, atr_points, setupTag);

   if(!PreFilterPass(spread_points, atr_points, bias, pullbackOk))
      return false;
      
   string trend = "range";
if(bias == "BULL") trend = "up";
else if(bias == "BEAR") trend = "down";

   bool hasPos = HasOpenPosition(InpSymbol);
   int posType = GetPositionType(InpSymbol);
   string posTypeStr = "";
   if(posType == POSITION_TYPE_BUY) posTypeStr = "BUY";
   if(posType == POSITION_TYPE_SELL) posTypeStr = "SELL";

   double body1 = MathAbs(rates[0].close - rates[0].open) / point;
   double range1 = MathAbs(rates[0].high - rates[0].low) / point;
   double closeToEMA20 = MathAbs(rates[0].close - ema20) / point;
   
   string payload = StringFormat(
   "{"
   "\"symbol\":\"%s\","
   "\"timeframe\":\"%s\","
   "\"session\":\"%s\","
   "\"bid\":%.2f,"
   "\"ask\":%.2f,"

   "\"spread\":%.1f,"
   "\"spread_points\":%.1f,"

   "\"has_position\":%s,"
   "\"position_type\":\"%s\","

   "\"ema_fast\":%.2f,"
   "\"ema_slow\":%.2f,"
   "\"ema20\":%.2f,"
   "\"rsi\":%.2f,"

   "\"atr\":%.1f,"
   "\"atr_points\":%.1f,"

   "\"trend\":\"%s\","
   "\"trend_bias\":\"%s\","

   "\"setup_tag\":\"%s\","
   "\"body1_points\":%.1f,"
   "\"range1_points\":%.1f,"
   "\"close_to_ema20_points\":%.1f,"
   "\"news_blocked\":%s,"
   "\"daily_loss_hit\":%s,"
   "\"candles\":%s"
   "}",
   EscapeJson(InpSymbol),
   EscapeJson(TFToText(InpTF)),
   EscapeJson(GetSessionName()),
   bid,
   ask,

   spread_points,
   spread_points,

   (hasPos ? "true" : "false"),
   posTypeStr,

   emaFast,
   emaSlow,
   ema20,
   rsi,

   atr_points,
   atr_points,

   EscapeJson(trend),
   EscapeJson(bias),

   EscapeJson(setupTag),
   body1,
   range1,
   closeToEMA20,
   (IsNewsBlockedNow() ? "true" : "false"),
   (DailyLossLimitHit() ? "true" : "false"),
   BuildCandlesJson(12)
);
   DebugPrint("Sending payload: " + payload);
return HttpPostJson(InpServerUrl, payload, responseText);
}

// =====================================================
// Execution
// =====================================================
bool ExecuteBuy(double sl_points, double tp_points, double risk_percent)
{
   if(!InpAllowBuy) return false;

   double ask   = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double point = SafePoint();
   double lot   = InpUseDynamicLot ? CalcLotByRisk(sl_points, risk_percent) : NormalizeLot(InpFixedLot);

   double sl = NormalizePrice(ask - sl_points * point);
   double tp = NormalizePrice(ask + tp_points * point);

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviationPoints);

   string comment = TradeCommentWithId("AI_BUY", g_lastDecisionTradeId);
   bool ok = trade.Buy(lot, InpSymbol, ask, sl, tp, comment);

   if(ok)
   {
      g_lastTradeBarTime = iTime(InpSymbol, InpTF, 0);
      InfoPrint(StringFormat("BUY opened | lot=%.2f sl=%.1f tp=%.1f tier=%s confidence>=%.0f", lot, sl_points, tp_points, g_lastDecisionTier, (double)InpMinConfidence));
   }
   else
   {
      InfoPrint("BUY failed retcode=" + IntegerToString((int)trade.ResultRetcode()));
   }
   return ok;
}

bool ExecuteSell(double sl_points, double tp_points, double risk_percent)
{
   if(!InpAllowSell) return false;

   double bid   = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double point = SafePoint();
   double lot   = InpUseDynamicLot ? CalcLotByRisk(sl_points, risk_percent) : NormalizeLot(InpFixedLot);

   double sl = NormalizePrice(bid + sl_points * point);
   double tp = NormalizePrice(bid - tp_points * point);

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviationPoints);

   string comment = TradeCommentWithId("AI_SELL", g_lastDecisionTradeId);
   bool ok = trade.Sell(lot, InpSymbol, bid, sl, tp, comment);

   if(ok)
   {
      g_lastTradeBarTime = iTime(InpSymbol, InpTF, 0);
      InfoPrint(StringFormat("SELL opened | lot=%.2f sl=%.1f tp=%.1f tier=%s confidence>=%.0f", lot, sl_points, tp_points, g_lastDecisionTier, (double)InpMinConfidence));
   }
   else
   {
      InfoPrint("SELL failed retcode=" + IntegerToString((int)trade.ResultRetcode()));
   }
   return ok;
}

// =====================================================
// Position management
// =====================================================
double GetCurrentRR(int type, double openPrice, double currentPrice, double initialSL)
{
   double riskDistance = MathAbs(openPrice - initialSL);
   if(riskDistance <= 0.0) return 0.0;

   if(type == POSITION_TYPE_BUY) return (currentPrice - openPrice) / riskDistance;
   return (openPrice - currentPrice) / riskDistance;
}

void ManagePartialTP()
{
   if(!InpUsePartialTP) return;

   ulong ticket = 0;
   long posId = 0;
   int type = -1;
   double openPrice = 0, sl = 0, tp = 0, volume = 0;
   string comment = "";

   if(!GetMyPosition(ticket, posId, type, openPrice, sl, tp, volume, comment)) return;
   if(IsPartialDone(posId)) return;

   double initSL = LoadInitSL(posId);
   if(initSL <= 0.0)
   {
      if(sl > 0.0)
      {
         initSL = sl;
         SaveInitSL(posId, initSL);
      }
      else return;
   }

   double riskDistance = MathAbs(openPrice - initSL);
   if(riskDistance <= 0.0) return;

   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double priceNow = (type == POSITION_TYPE_BUY ? bid : ask);

   double targetPrice = 0.0;
   bool hitTarget = false;

   if(type == POSITION_TYPE_BUY)
   {
      targetPrice = openPrice + (riskDistance * InpPartialTP_RR);
      hitTarget = (priceNow >= targetPrice);
   }
   else
   {
      targetPrice = openPrice - (riskDistance * InpPartialTP_RR);
      hitTarget = (priceNow <= targetPrice);
   }

   if(!hitTarget) return;

   double closeVol = NormalizeLot(volume * (InpPartialClosePercent / 100.0));
   double minLot = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
   double remain = volume - closeVol;

   if(closeVol < minLot || remain < minLot)
   {
      SavePartialDone(posId);
      return;
   }

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviationPoints);

   bool ok = trade.PositionClosePartial(ticket, closeVol, InpDeviationPoints);
   if(ok)
   {
      SavePartialDone(posId);
      InfoPrint("Partial TP done");

      if(InpMoveSLToBEAfterPart && PositionSelectByTicket(ticket))
      {
         double curTP = PositionGetDouble(POSITION_TP);
         trade.PositionModify(ticket, NormalizePrice(openPrice), curTP);
      }
   }
}

void ManageTrailingStop()
{
   ulong ticket = 0;
   long posId = 0;
   int type = -1;
   double openPrice = 0, sl = 0, tp = 0, volume = 0;
   string comment = "";

   if(!GetMyPosition(ticket, posId, type, openPrice, sl, tp, volume, comment)) return;

   double initSL = LoadInitSL(posId);
   if(initSL <= 0.0) return;
   if(InpTrailAfterPartialOnly && !IsPartialDone(posId)) return;

   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double currentPrice = (type == POSITION_TYPE_BUY ? bid : ask);
   double rrNow = GetCurrentRR(type, openPrice, currentPrice, initSL);
   if(rrNow < InpTrailActivateRR) return;

   double ema20 = 0.0;
   double atr = 0.0;
   if(InpUseEMA20Trailing && !ReadBufferValue(hEMA20, 1, ema20)) return;
   if(InpUseATRTrailing && !ReadBufferValue(hATR, 1, atr)) return;

   double point = SafePoint();
   int stopsLevel = (int)SymbolInfoInteger(InpSymbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minStopDistance = stopsLevel * point;
   double newSL = sl;

   if(type == POSITION_TYPE_BUY)
   {
      double candidate = (sl > 0.0 ? sl : initSL);
      if(InpUseEMA20Trailing) candidate = MathMax(candidate, ema20);
      if(InpUseATRTrailing) candidate = MathMax(candidate, bid - atr * InpATRTrailMult);
      double maxAllowedSL = bid - minStopDistance;
      if(candidate > maxAllowedSL) candidate = maxAllowedSL;
      if(IsPartialDone(posId) && candidate < openPrice) candidate = openPrice;
      if(candidate > sl + point * 5) newSL = candidate;
   }
   else
   {
      double candidate = (sl > 0.0 ? sl : initSL);
      if(InpUseEMA20Trailing) candidate = MathMin(candidate, ema20);
      if(InpUseATRTrailing) candidate = MathMin(candidate, ask + atr * InpATRTrailMult);
      double minAllowedSL = ask + minStopDistance;
      if(candidate < minAllowedSL) candidate = minAllowedSL;
      if(IsPartialDone(posId) && candidate > openPrice) candidate = openPrice;
      if(candidate < sl - point * 5 || sl <= 0.0) newSL = candidate;
   }

   newSL = NormalizePrice(newSL);
   if(newSL > 0.0 && MathAbs(newSL - sl) > point * 5)
   {
      trade.SetExpertMagicNumber(InpMagic);
      trade.SetDeviationInPoints(InpDeviationPoints);
      trade.PositionModify(ticket, newSL, tp);
   }
}

// =====================================================
// Trade-result reporting
// =====================================================
bool ReportTradeResult(string tradeId, string resultLabel, double pnl, double rrResult, string closeReason, double holdingMinutes)
{
   if(tradeId == "")
   {
      Print("ReportTradeResult skipped: empty tradeId");
      return false;
   }

   string payload = StringFormat(
      "{\"trade_id\":\"%s\","
      "\"result\":\"%s\","
      "\"pnl\":%.2f,"
      "\"rr_result\":%.2f,"
      "\"close_reason\":\"%s\","
      "\"holding_minutes\":%.1f}",
      EscapeJson(tradeId),
      EscapeJson(resultLabel),
      pnl,
      rrResult,
      EscapeJson(closeReason),
      holdingMinutes
   );

   Print("Reporting trade result payload: ", payload);

   string response = "";
   bool ok = HttpPostJson(InpTradeResultUrl, payload, response);

   Print("Trade result HTTP ok = ", ok, " | response = ", response);

   if(ok)
      Print("Trade result reported: ", tradeId);
   else
      Print("Trade result FAILED: ", tradeId);

   return ok;
}

void CheckRecentlyClosedTradesAndReport()
{
   datetime from = TimeCurrent() - 86400 * 5;
   datetime to   = TimeCurrent();
   if(!HistorySelect(from, to)) return;

   int deals = HistoryDealsTotal();
   if(deals <= 0) return;

   for(int i = 0; i < deals; i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;

      if(HistoryDealGetString(dealTicket, DEAL_SYMBOL) != InpSymbol) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != InpMagic) continue;

      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      long posId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);

      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      if(IsReported(posId)) continue;

      double pnlThisDeal = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                         + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION)
                         + HistoryDealGetDouble(dealTicket, DEAL_SWAP);
      AddClosedPnl(posId, pnlThisDeal);
   }

   for(int i = 0; i < deals; i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;

      if(HistoryDealGetString(dealTicket, DEAL_SYMBOL) != InpSymbol) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != InpMagic) continue;

      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      long posId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);

      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      if(IsReported(posId)) continue;

      bool stillOpen = false;
      for(int p = PositionsTotal() - 1; p >= 0; p--)
      {
         ulong posTicket = PositionGetTicket(p);
         if(posTicket == 0) continue;
         if(!PositionSelectByTicket(posTicket)) continue;

         if(PositionGetString(POSITION_SYMBOL) == InpSymbol &&
            PositionGetInteger(POSITION_MAGIC) == InpMagic &&
            PositionGetInteger(POSITION_IDENTIFIER) == posId)
         {
            stillOpen = true;
            break;
         }
      }
      if(stillOpen) continue;

      string tradeId = "";
      string openComment = "";
      for(int j = 0; j < deals; j++)
      {
         ulong openDealTicket = HistoryDealGetTicket(j);
         if(openDealTicket == 0) continue;

         if(HistoryDealGetString(openDealTicket, DEAL_SYMBOL) != InpSymbol) continue;
         if(HistoryDealGetInteger(openDealTicket, DEAL_MAGIC) != InpMagic) continue;
         if(HistoryDealGetInteger(openDealTicket, DEAL_POSITION_ID) != posId) continue;

         if(HistoryDealGetInteger(openDealTicket, DEAL_ENTRY) == DEAL_ENTRY_IN)
         {
            openComment = HistoryDealGetString(openDealTicket, DEAL_COMMENT);
            tradeId = ExtractIdFromComment(openComment);
            break;
         }
      }

      double totalPnl    = LoadClosedPnl(posId);
      double riskMoney   = LoadRiskMoney(posId);
      datetime entryTime = LoadEntryTime(posId);
      double rrResult = (riskMoney > 0.0 ? totalPnl / riskMoney : 0.0);

      string resultLabel = "BREAKEVEN";
      if(totalPnl > 0.0) resultLabel = "WIN";
      if(totalPnl < 0.0) resultLabel = "LOSS";

      string closeReason = (totalPnl >= 0.0 ? "TP_OR_TRAIL" : "SL_OR_STOP");
      double holdingMinutes = (entryTime > 0 ? (double)(TimeCurrent() - entryTime) / 60.0 : 0.0);

      if(tradeId == "")
      {
         MarkReported(posId);
         CleanupTradeState(posId);
         continue;
      }

      if(ReportTradeResult(tradeId, resultLabel, totalPnl, rrResult, closeReason, holdingMinutes))
      {
         MarkReported(posId);
         CleanupTradeState(posId);
      }
      Print("Check closed posId=", posId);
Print("Recovered openComment=", openComment);
Print("Recovered tradeId=", tradeId);
Print("stillOpen=", stillOpen);
Print("totalPnl=", totalPnl, " riskMoney=", riskMoney, " rr=", rrResult);
   }
}

// =====================================================
// Response processing
// =====================================================
void ProcessDecision(const string response)
{
   string decisionJson = ParseDecisionObject(response);

   string tradeId      = JsonGetString(response, "trade_id");
   string routeTier    = JsonGetString(response, "route_tier");
   string source       = JsonGetString(response, "source");
   string model        = JsonGetString(response, "model");

   string action       = JsonGetString(decisionJson, "action");
   string reasonCode   = JsonGetString(decisionJson, "reason_code");
   double confidence   = JsonGetNumber(decisionJson, "confidence");
   double ai_sl_points = JsonGetNumber(decisionJson, "sl_points");
   double ai_tp_points = JsonGetNumber(decisionJson, "tp_points");
   double risk_percent = JsonGetNumber(decisionJson, "risk_percent");

   if(DailyLossLimitHit()) return;
   if(confidence < InpMinConfidence) return;

   double atr;
   if(!ReadBufferValue(hATR, 1, atr)) return;
   double atr_points = atr / SafePoint();

   double min_sl_points = atr_points * 0.80;
   double max_sl_points = atr_points * 1.35;

   double sl_points = ai_sl_points;
   if(sl_points <= 0.0) sl_points = atr_points * 0.95;
   if(sl_points < min_sl_points) sl_points = min_sl_points;
   if(sl_points > max_sl_points) sl_points = max_sl_points;

   double min_rr = 1.60;
   double preferred_rr = 2.00;
   if(atr_points >= 1200) preferred_rr = 2.20;

   double tp_points = ai_tp_points;
   if(tp_points <= 0.0 || tp_points < sl_points * min_rr)
      tp_points = sl_points * preferred_rr;

   g_lastDecisionTradeId  = tradeId;
   g_lastDecisionAction   = action;
   g_lastDecisionTier     = routeTier;
   g_lastDecisionReason   = reasonCode;
   g_lastDecisionSource   = source;
   g_lastDecisionModel    = model;
   g_lastDecisionSLPoints = sl_points;
   g_lastDecisionTPPoints = tp_points;
   g_lastDecisionRiskPct  = (risk_percent > 0.0 ? risk_percent : InpRiskPercentFallback);

   if(InpPrintDecisionSummary)
   {
      InfoPrint(StringFormat(
         "Decision | action=%s confidence=%.0f tier=%s source=%s model=%s reason=%s sl=%.1f tp=%.1f risk=%.2f%% trade_id=%s",
         action, confidence, routeTier, source, model, reasonCode, sl_points, tp_points, g_lastDecisionRiskPct, tradeId
      ));
   }

   if(action == "BUY") ExecuteBuy(sl_points, tp_points, g_lastDecisionRiskPct);
   else if(action == "SELL") ExecuteSell(sl_points, tp_points, g_lastDecisionRiskPct);
   else if(action == "CLOSE") CloseMyPositions();
}

// =====================================================
// Lifecycle
// =====================================================
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviationPoints);

   hFastEMA = iMA(InpSymbol, InpTF, InpFastEMA, 0, MODE_EMA, PRICE_CLOSE);
   hSlowEMA = iMA(InpSymbol, InpTF, InpSlowEMA, 0, MODE_EMA, PRICE_CLOSE);
   hEMA20   = iMA(InpSymbol, InpTF, InpEMA20Period, 0, MODE_EMA, PRICE_CLOSE);
   hRSI     = iRSI(InpSymbol, InpTF, InpRSIPeriod, PRICE_CLOSE);
   hATR     = iATR(InpSymbol, InpTF, InpATRPeriod);

   if(hFastEMA == INVALID_HANDLE || hSlowEMA == INVALID_HANDLE || hEMA20 == INVALID_HANDLE || hRSI == INVALID_HANDLE || hATR == INVALID_HANDLE)
   {
      InfoPrint("Indicator handle creation failed");
      return INIT_FAILED;
   }

   InfoPrint("AI EA V2 initialized");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(hFastEMA != INVALID_HANDLE) IndicatorRelease(hFastEMA);
   if(hSlowEMA != INVALID_HANDLE) IndicatorRelease(hSlowEMA);
   if(hEMA20   != INVALID_HANDLE) IndicatorRelease(hEMA20);
   if(hRSI     != INVALID_HANDLE) IndicatorRelease(hRSI);
   if(hATR     != INVALID_HANDLE) IndicatorRelease(hATR);
}

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;

   ulong deal = trans.deal;
   if(deal <= 0) return;
   if(!HistoryDealSelect(deal)) return;

   if(HistoryDealGetString(deal, DEAL_SYMBOL) != InpSymbol) return;
   if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) return;

   long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
   long posId = HistoryDealGetInteger(deal, DEAL_POSITION_ID);

   if(entry == DEAL_ENTRY_IN)
   {
      double dealPrice  = HistoryDealGetDouble(deal, DEAL_PRICE);
      double dealVolume = HistoryDealGetDouble(deal, DEAL_VOLUME);

      Sleep(100);

      double initSL = 0.0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong posTicket = PositionGetTicket(i);
         if(posTicket == 0) continue;
         if(!PositionSelectByTicket(posTicket)) continue;

         if(PositionGetString(POSITION_SYMBOL) == InpSymbol &&
            PositionGetInteger(POSITION_MAGIC) == InpMagic &&
            PositionGetInteger(POSITION_IDENTIFIER) == posId)
         {
            initSL = PositionGetDouble(POSITION_SL);
            break;
         }
      }

      if(initSL > 0.0)
      {
         SaveInitSL(posId, initSL);
         double slPoints = MathAbs(dealPrice - initSL) / SafePoint();
         double riskMoney = slPoints * CalcMoneyPerPointPerLot() * dealVolume;
         SaveRiskMoney(posId, riskMoney);
         SaveEntryTime(posId, TimeCurrent());
      }
   }

   if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
      CheckRecentlyClosedTradesAndReport();
}

void OnTick()
{
   if(_Symbol != InpSymbol) return;

   EnforceDailyLossLimit();
   ManagePartialTP();
   ManageTrailingStop();

   bool shouldEvaluate = true;
   if(InpOnlyNewBarDecision)
      shouldEvaluate = IsNewBar();

   if(!shouldEvaluate) return;
   if(DailyLossLimitHit()) return;

   string response = "";
   if(RequestDecision(response))
      ProcessDecision(response);
}
