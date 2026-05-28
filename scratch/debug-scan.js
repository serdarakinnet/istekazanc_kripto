const fs = require('fs');

async function debugScan() {
  const fetch = global.fetch;
  
  // 1. Fetch tickers
  const tRes = await fetch('https://istekazanckripto.vercel.app/api/market/ticker/24hr?timeoutMs=5000');
  const tData = await tRes.json();
  const tickers = tData.data.filter(t => t.symbol.endsWith('TRY') && !t.symbol.includes('USDT'));
  
  // Sort by volume and pick top 20
  tickers.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  const top20 = tickers.slice(0, 20);
  
  console.log('Top 20 symbols:', top20.map(t => t.symbol).join(', '));
  
  // 2. We will test the score logic directly here!
  function scoreCandidate(closes, highs, lows, volumes) {
      function calcEMA(data, p) {
        if (!Array.isArray(data) || data.length < p) return null;
        const k = 2 / (p + 1);
        let e = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
        for (let i = p; i < data.length; i++) e = data[i] * k + e * (1 - k);
        return e;
      }
      function calcRSI(data, p = 14) {
        let g = 0, l = 0;
        for (let i = 1; i <= p; i++) {
          const d = data[i] - data[i - 1];
          if (d > 0) g += d; else l -= d;
        }
        let ag = g / p, al = l / p;
        for (let i = p + 1; i < data.length; i++) {
          const d = data[i] - data[i - 1];
          ag = (ag * (p - 1) + Math.max(d, 0)) / p;
          al = (al * (p - 1) + Math.max(-d, 0)) / p;
        }
        if (al === 0) return 100;
        return 100 - 100 / (1 + ag / al);
      }
      function calcATR(h, l, c, p = 14) {
        const trs = [];
        for (let i = 1; i < h.length; i++) {
          trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
        }
        return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
      }
      function calcMACD(data) {
        const series = [];
        for (let i = 26; i <= data.length; i++) {
          const e12 = calcEMA(data.slice(0, i), 12);
          const e26 = calcEMA(data.slice(0, i), 26);
          if (e12 != null && e26 != null) series.push(e12 - e26);
        }
        const macd = series[series.length - 1];
        const signal = calcEMA(series, 9);
        const hist = signal == null ? null : macd - signal;
        return { hist };
      }

      const price = closes[closes.length - 1];
      const e5 = calcEMA(closes, 5);
      const e21 = calcEMA(closes, 21);
      const e55 = calcEMA(closes, 55);
      const rsi = calcRSI(closes, 14);
      const atr = calcATR(highs, lows, closes, 14);
      const macd = calcMACD(closes);

      const vol20 = volumes.slice(-20);
      const vol20avg = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
      const curVol = volumes[volumes.length - 1];
      const volMult = vol20avg > 0 ? Number((curVol / vol20avg).toFixed(2)) : 0;

      const trendLong = e5 > e21 && e21 > e55;
      const macdLong = macd.hist != null && macd.hist > 0;
      const volLong = volMult >= 1.1;

      const gates = [trendLong, macdLong, volLong].filter(Boolean).length;
      let longScore = gates * 20 + (rsi > 50 ? 10 : 0) + (volMult > 1.5 ? 10 : 0);
      longScore = Math.max(0, Math.min(100, Math.round(longScore)));

      let stop = Math.min(price - atr * 1.6, Math.min(...lows.slice(-20)) * 0.99);
      stop = Math.max(stop, price * 0.90); 
      stop = Math.min(stop, price * 0.95); 

      const risk = price - stop;
      const longTarget = price + risk * 2.5;
      const longRR = risk > 0 ? ((longTarget - price) / risk) : 0;

      const scoreOk = longScore >= 40;

      return {
        ok: scoreOk,
        score: longScore,
        gates, rsi, volMult, e5, e21, e55,
        flatPenalty: rsi < 40 || rsi > 75,
        pumpPenalty: volMult >= 3.5 && rsi > 80,
      };
  }

  for (const t of top20) {
    const kRes = await fetch(`https://istekazanckripto.vercel.app/api/market/klines?symbol=${t.symbol}&interval=1h&limit=200&timeoutMs=5000`);
    const kData = await kRes.json();
    if (!kData.ok || !kData.data || kData.data.length < 60) continue;
    
    const rows = kData.data;
    const closes = rows.map(r => Number(r[4]));
    const highs = rows.map(r => Number(r[2]));
    const lows = rows.map(r => Number(r[3]));
    const volumes = rows.map(r => Number(r[5]));

    const res = scoreCandidate(closes, highs, lows, volumes);
    
    // AI Filter
    const aiPassed = res.ok && !res.flatPenalty && !res.pumpPenalty && t.symbol !== 'BTCTRY' && t.symbol !== 'ETHTRY';

    console.log(`${t.symbol.padEnd(10)} | Score: ${res.score} | Gates: ${res.gates} | RSI: ${res.rsi.toFixed(1)} | flat: ${res.flatPenalty} | AI Pass: ${aiPassed}`);
  }
}

debugScan().catch(console.error);
