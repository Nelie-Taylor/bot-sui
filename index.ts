import 'dotenv/config'
import axios from 'axios'
import chalk from 'chalk'
import ora from 'ora'
import { table } from 'table'

const BASE_URL = 'https://www.okx.com'
const SYMBOL = 'SUI-USDT-SWAP'
const INST_TYPE = 'SWAP'
const UNDERLYING = 'SUI-USDT'
const api = axios.create({ baseURL: BASE_URL })

async function getFunding() {
  const { data } = await api.get('/api/v5/public/funding-rate', { params: { instId: SYMBOL } })
  return Number(data.data[0].fundingRate)
}

async function getLongShortRatio() {
  try {
    const { data } = await api.get('/api/v5/public/account-ratio', {
      params: { uly: UNDERLYING, instType: INST_TYPE, period: '5m' }
    })
    const last = data.data.at(-1)
    return Number(last.longShortRatio)
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      const { data } = await api.get('/api/v5/rubik/stat/contracts/long-short-account-ratio', {
        params: { instType: INST_TYPE, ccy: UNDERLYING, period: '5m' }
      })
      const last = data.data.at(-1)
      const ratio = last?.longShortRatio ?? last?.ratio ?? last?.value
      if (ratio === undefined) {
        throw new Error('Không tìm được dữ liệu long/short ratio từ OKX (rubik).')
      }
      return Number(ratio)
    }
    throw error
  }
}

async function getOI() {
  const { data } = await api.get('/api/v5/public/open-interest', {
    params: { uly: UNDERLYING, instType: INST_TYPE }
  })
  return Number(data.data[0].oi)
}

async function getTakerFlow() {
  const { data } = await api.get('/api/v5/public/taker-volume', {
    params: { uly: UNDERLYING, instType: INST_TYPE, period: '5m' }
  })
  const last = data.data.at(-1)
  const delta = Number(last.buyVolUsd) - Number(last.sellVolUsd)
  return delta
}

async function getLiquidations() {
  const { data } = await api.get('/api/v5/public/liquidation-orders', {
    params: { uly: UNDERLYING, instType: INST_TYPE, type: 'filled', limit: 100 }
  })
  const longs = data.data.filter(x => x.posSide === 'long')
  const shorts = data.data.filter(x => x.posSide === 'short')
  return { longCount: longs.length, shortCount: shorts.length }
}

async function getPrice() {
  const { data } = await api.get('/api/v5/market/ticker', { params: { instId: SYMBOL } })
  return Number(data.data[0].last)
}

function colorBool(ok) {
  return ok ? chalk.green('✅') : chalk.red('❌')
}

async function run() {
  const spin = ora(`Đang lấy dữ liệu ${SYMBOL} từ OKX...`).start()

  try {
    const [funding, ratio, oi, taker, liq, price] = await Promise.all([
      getFunding(),
      getLongShortRatio(),
      getOI(),
      getTakerFlow(),
      getLiquidations(),
      getPrice()
    ])

    spin.succeed('Đã lấy dữ liệu thành công.')
    const fundPct = funding * 100

    // ====== PHÂN TÍCH ======
    const fundingLongBias = fundPct > 0.01
    const fundingShortBias = fundPct < -0.01
    const ratioLongBias = ratio > 1
    const ratioShortBias = ratio < 1
    const takerBuy = taker > 0
    const takerSell = taker < 0

    let signal = 'WAIT'
    let direction = '-'
    let reason = ''
    let entry = price
    let sl, tp

    if (fundingLongBias && ratioLongBias && takerSell) {
      signal = 'READY'
      direction = 'SHORT'
      reason = 'Funding và Retail Long đông, Taker đang bán → trap Long.'
      tp = (price * 0.98).toFixed(4)
      sl = (price * 1.01).toFixed(4)
    } else if (fundingShortBias && ratioShortBias && takerBuy) {
      signal = 'READY'
      direction = 'LONG'
      reason = 'Funding âm, Retail Short đông, Taker mua → trap Short.'
      tp = (price * 1.02).toFixed(4)
      sl = (price * 0.99).toFixed(4)
    } else {
      reason = 'Chưa đủ điều kiện lệch pha rõ ràng.'
    }

    // ====== BẢNG TÓM TẮT ======
    const rows = [
      ['Funding Rate', `${fundPct.toFixed(3)}%`, fundingLongBias ? 'Retail Long đông' : fundingShortBias ? 'Retail Short đông' : 'Trung tính'],
      ['Long/Short Ratio', ratio.toFixed(2), ratio > 1 ? 'Nghiêng Long' : 'Nghiêng Short'],
      ['Open Interest', oi.toLocaleString(), 'Tổng vị thế mở'],
      ['Taker Flow (Δ USD)', taker.toFixed(0), taker > 0 ? 'Buy áp đảo' : 'Sell áp đảo'],
      ['Liquidations', `${liq.longCount} Long | ${liq.shortCount} Short`, 'Thanh lý gần nhất'],
      ['Giá hiện tại', price, '-'],
    ]

    console.log(table(rows))

    console.log(chalk.bold(`Tín hiệu: ${signal === 'READY' ? chalk.green(signal) : chalk.yellow(signal)}`))
    console.log(chalk.bold(`Chiều: ${direction}`))
    console.log(chalk.cyan(reason))

    if (signal === 'READY') {
      console.log(chalk.green(`→ Entry: ${price}`))
      console.log(chalk.red(`→ Stop Loss: ${sl}`))
      console.log(chalk.yellow(`→ Take Profit: ${tp}`))
    }

  } catch (err) {
    spin.fail('Lỗi khi lấy dữ liệu:')
    console.error(err)
  }
}

run()
