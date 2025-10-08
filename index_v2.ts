import axios from "axios";

const API_BASE = "https://www.okx.com";
const UNDERLYING = "SUI-USDT";
const INST_TYPE = "SWAP";

// ========== TYPES ==========
interface SignalResult {
  timestamp: string;
  whaleTrend: "increasing" | "decreasing" | "neutral";
  oiTrend: "increasing" | "decreasing" | "neutral";
  cvdSignal: "bullish" | "bearish" | "neutral";
  liquidationBias: "long_liq" | "short_liq" | "none";
  signal: "LONG" | "SHORT" | "WAIT";
  comment: string;
}

interface TradeSetup extends SignalResult {
  entry?: number;
  tp?: number;
  sl?: number;
  rr?: number;
}

// ========== UTILS ==========
function calcTrend(values: number[]): "increasing" | "decreasing" | "neutral" {
  if (values.length < 2) return "neutral";
  const diff = values.at(-1)! - values.at(-2)!;
  if (diff > 0) return "increasing";
  if (diff < 0) return "decreasing";
  return "neutral";
}

async function getLiquidationBias(): Promise<"long_liq" | "short_liq" | "none"> {
  const { data } = await axios.get(`${API_BASE}/api/v5/public/liquidation-orders`, {
    params: { uly: UNDERLYING, instType: INST_TYPE, state: "filled", limit: 100 },
  });
  const longs = data.data.filter((x: any) => x.posSide === "long").length;
  const shorts = data.data.filter((x: any) => x.posSide === "short").length;
  if (longs > shorts * 1.5) return "long_liq";
  if (shorts > longs * 1.5) return "short_liq";
  return "none";
}

// ========== MODULE: Whale Trend (giả lập) ==========
async function getWhaleTrend(): Promise<"increasing" | "decreasing" | "neutral"> {
  const [oiRes, candleRes, liqRes] = await Promise.all([
    axios.get(`${API_BASE}/api/v5/public/open-interest`, {
      params: { instType: INST_TYPE, uly: UNDERLYING },
    }),
    axios.get(`${API_BASE}/api/v5/market/history-candles`, {
      params: { instId: `${UNDERLYING}-SWAP`, bar: "15m", limit: 15 },
    }),
    axios.get(`${API_BASE}/api/v5/public/liquidation-orders`, {
      params: { uly: UNDERLYING, instType: INST_TYPE, state: "filled", limit: 100 },
    }),
  ]);

  const oiArr = oiRes.data.data.slice(-5).map((x: any) => parseFloat(x.oi));
  const candles = candleRes.data.data.slice(-5).map((x: any) => ({
    open: parseFloat(x[1]),
    close: parseFloat(x[4]),
  }));

  const longs = liqRes.data.data.filter((x: any) => x.posSide === "long").length;
  const shorts = liqRes.data.data.filter((x: any) => x.posSide === "short").length;

  const oiTrend =
    oiArr.at(-1)! > oiArr.at(-2)! ? "increasing" : "decreasing";
  const priceTrend =
    candles[0].close < candles.at(-1)!.close ? "up" : "down";
  const liqBias = longs > shorts * 1.5 ? "long_liq" : shorts > longs * 1.5 ? "short_liq" : "none";

  if (priceTrend === "up" && oiTrend === "increasing" && liqBias === "short_liq") return "increasing";
  if (priceTrend === "down" && oiTrend === "increasing" && liqBias === "long_liq") return "decreasing";
  return "neutral";
}

// ========== MODULE: OI ==========
async function getOpenInterest(): Promise<number[]> {
  const { data } = await axios.get(`${API_BASE}/api/v5/public/open-interest`, {
    params: { instType: INST_TYPE, uly: UNDERLYING },
  });
  return data.data.slice(-5).map((x: any) => parseFloat(x.oi));
}

// ========== MODULE: CVD ==========
async function getCVD(): Promise<number[]> {
  const { data } = await axios.get(`${API_BASE}/api/v5/market/history-trades`, {
    params: { instId: `${UNDERLYING}-SWAP`, limit: 200 },
  });
  const cvd: number[] = [];
  let cum = 0;
  for (const x of data.data.reverse()) {
    const size = parseFloat(x.sz);
    cum += x.side === "buy" ? size : -size;
    cvd.push(cum);
  }
  return cvd;
}

// ========== MODULE: PRICE + ATR ==========
async function getMarketATR() {
  const { data } = await axios.get(`${API_BASE}/api/v5/market/history-candles`, {
    params: { instId: `${UNDERLYING}-SWAP`, bar: "15m", limit: 15 },
  });
  const candles = data.data.map((c: any) => ({
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
  }));
  const price = candles[0].close;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i];
    const cur = candles[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  return { price, atr };
}

// ========== CORE LOGIC ==========
async function getSignal(): Promise<SignalResult> {
  const [whaleTrend, oiArr, cvdArr, liqBias] = await Promise.all([
    getWhaleTrend(),
    getOpenInterest(),
    getCVD(),
    getLiquidationBias(),
  ]);

  const oiTrend = calcTrend(oiArr);
  const cvdChange = cvdArr.at(-1)! - cvdArr.at(-2)!;
  const cvdSignal = cvdChange > 0 ? "bullish" : cvdChange < 0 ? "bearish" : "neutral";

  let signal: SignalResult["signal"] = "WAIT";
  let comment = "Chưa có setup rõ ràng.";

  if (whaleTrend === "decreasing" && oiTrend === "increasing") {
    if (cvdSignal === "bearish" || liqBias === "long_liq") {
      signal = "SHORT";
      comment = "Whale giảm + OI tăng + CVD âm → ưu tiên SHORT.";
    }
  }

  if (whaleTrend === "increasing" && oiTrend === "increasing") {
    if (cvdSignal === "bullish" || liqBias === "short_liq") {
      signal = "LONG";
      comment = "Whale tăng + OI tăng + CVD dương → ưu tiên LONG.";
    }
  }

  if (whaleTrend === "neutral" || oiTrend === "neutral") {
    signal = "WAIT";
    comment = "Chưa có sự lệch pha rõ giữa cá voi và OI.";
  }

  return {
    timestamp: new Date().toISOString(),
    whaleTrend,
    oiTrend,
    cvdSignal,
    liquidationBias: liqBias,
    signal,
    comment,
  };
}

// ========== FINAL TRADE OUTPUT ==========
export async function getTradeSetup(): Promise<TradeSetup> {
  const signalData = await getSignal();
  const { price, atr } = await getMarketATR();

  let entry, tp, sl, rr;
  const atrMult = 1.5;
  const rrRatio = 2;

  if (signalData.signal === "LONG") {
    entry = price;
    sl = price - atr * atrMult;
    tp = price + atr * atrMult * rrRatio;
    rr = (tp - entry) / (entry - sl);
  } else if (signalData.signal === "SHORT") {
    entry = price;
    sl = price + atr * atrMult;
    tp = price - atr * atrMult * rrRatio;
    rr = (entry - tp) / (sl - entry);
  }

  return { ...signalData, entry, tp, sl, rr };
}

// ========== TELEGRAM ALERT ==========
async function sendTelegram(message: string) {
  const token = '8498310615:AAFQTW6sqZtKpphLWjJqD3OGWP8wDQQsPdA';
  const chatId = '-4688130983';
  if (!token || !chatId) return console.warn("⚠️ Missing TELEGRAM_BOT_TOKEN or CHAT_ID");
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
  });
}

// ========== MAIN ==========
async function main() {
  const setup = await getTradeSetup();

  console.table(setup);

  if (setup.signal !== "WAIT") {
    const msg = `
🦈 <b>SUI Futures x50 Alert</b>
Signal: <b>${setup.signal}</b>
Entry: ${setup.entry?.toFixed(4)}
TP: ${setup.tp?.toFixed(4)}
SL: ${setup.sl?.toFixed(4)}
R:R ≈ ${setup.rr?.toFixed(2)}
Comment: ${setup.comment}
Time: ${new Date().toLocaleString("vi-VN")}
`;
    await sendTelegram(msg);
    console.log("🚨 Gửi tín hiệu tới Telegram thành công!");
  } else {
    console.log("⏳ Chưa có tín hiệu trade hợp lệ.");
  }
}
sendTelegram('Start bot')
setInterval(() => {
    console.clear();
    main();
}, 60000)