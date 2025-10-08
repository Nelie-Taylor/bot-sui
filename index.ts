/**
 * SUI Futures Signal Generator (No Funding Version)
 * --------------------------------------------------
 * Logic:
 * 1. Lấy dữ liệu Whale Index, OI, CVD, Liquidations từ OKX.
 * 2. Xác định tín hiệu dựa trên tương quan:
 *    - Whale giảm + OI tăng → Short bias
 *    - Whale tăng + OI tăng → Long bias
 *    - Sau đó, xác nhận entry bằng CVD đảo hướng gần vùng heatmap thanh lý.
 */

import axios from "axios";

const API_BASE = "https://www.okx.com";
const UNDERLYING = "SUI-USDT";
const INST_TYPE = "SWAP";

interface SignalResult {
  timestamp: string;
  whaleTrend: "increasing" | "decreasing" | "neutral";
  oiTrend: "increasing" | "decreasing" | "neutral";
  cvdSignal: "bullish" | "bearish" | "neutral";
  liquidationBias: "long_liq" | "short_liq" | "none";
  signal: "LONG" | "SHORT" | "WAIT";
  comment: string;
}

// --- Utility ---
function calcTrend(values: number[]): "increasing" | "decreasing" | "neutral" {
  if (values.length < 2) return "neutral";
  const diff = values[values.length - 1] - values[values.length - 2];
  if (diff > 0) return "increasing";
  if (diff < 0) return "decreasing";
  return "neutral";
}
async function getWhaleTrend(): Promise<"increasing" | "decreasing" | "neutral"> {
    const [oiRes, candleRes, liqRes] = await Promise.all([
      axios.get(`${API_BASE}/api/v5/public/open-interest`, {
        params: { instType: INST_TYPE, uly: UNDERLYING },
      }),
      axios.get(`${API_BASE}/api/v5/market/history-candles`, {
        params: { instId: `${UNDERLYING}-SWAP`, bar: "15m", limit: 5 },
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
      oiArr[oiArr.length - 1] > oiArr[oiArr.length - 2] ? "increasing" : "decreasing";
    const priceTrend =
      candles[0].close < candles[candles.length - 1].close ? "up" : "down";
    const liqBias = longs > shorts * 1.5 ? "long_liq" : shorts > longs * 1.5 ? "short_liq" : "none";
  
    // --- Whale Trend Logic ---
    if (priceTrend === "up" && oiTrend === "increasing" && liqBias === "short_liq")
      return "increasing"; // Whale đang gom
    if (priceTrend === "down" && oiTrend === "increasing" && liqBias === "long_liq")
      return "decreasing"; // Whale đang xả
    return "neutral";
  }
  
async function getOpenInterest(): Promise<number[]> {
  const { data } = await axios.get(`${API_BASE}/api/v5/public/open-interest`, {
    params: { instType: INST_TYPE, uly: UNDERLYING },
  });
  return data.data.slice(-5).map((x: any) => parseFloat(x.oi));
}

async function getCVD(): Promise<number[]> {
    const { data } = await axios.get(`${API_BASE}/api/v5/market/history-trades`, {
      params: { instId: `${UNDERLYING}-SWAP`, limit: 200 },
    });
  
    // CVD = cumulative (buyVol - sellVol)
    const cvd: number[] = [];
    let cum = 0;
  
    // newest -> oldest => đảo ngược
    for (const x of data.data.reverse()) {
      const size = parseFloat(x.sz);
      cum += x.side === "buy" ? size : -size;
      cvd.push(cum);
    }
    return cvd;
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

// --- Decision Engine ---
export async function getSignal(): Promise<SignalResult> {
  try {
    const [oiArr, cvdArr, liqBias] = await Promise.all([
      getOpenInterest(),
      getCVD(),
      getLiquidationBias(),
    ]);

    const whaleTrend = await getWhaleTrend();
    const oiTrend = calcTrend(oiArr);

    // CVD direction (buy pressure)
    const cvdChange = cvdArr[cvdArr.length - 1] - cvdArr[cvdArr.length - 2];
    const cvdSignal = cvdChange > 0 ? "bullish" : cvdChange < 0 ? "bearish" : "neutral";

    let signal: SignalResult["signal"] = "WAIT";
    let comment = "Chưa có setup rõ ràng.";

    // ---- Logic ra tín hiệu ----
    if (whaleTrend === "decreasing" && oiTrend === "increasing") {
      // Cá voi bán, OI tăng → retail đang long, trap short
      if (cvdSignal === "bearish" || liqBias === "long_liq") {
        signal = "SHORT";
        comment = "Whale giảm + OI tăng + CVD âm → ưu tiên SHORT.";
      }
    }

    if (whaleTrend === "increasing" && oiTrend === "increasing") {
      // Cá voi mua, OI tăng → retail short, trap long
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
  } catch (err) {
    console.error("Error fetching data:", err);
    throw err;
  }
}

setInterval(() => {
    console.clear();
    getSignal().then((res) => console.table(res));
}, 60000)