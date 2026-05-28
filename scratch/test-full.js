const fetch = global.fetch;

async function testFullScan() {
  console.log("Triggering /scan on Vercel...");
  // Vercel server does NOT have a full scan endpoint. It has /api/market/ticker/24hr and /api/market/klines.
  // We need to test the actual frontend scan behavior by fetching /api/market/ticker/24hr and seeing if ANY klines request fails.
  
  const tRes = await fetch('https://istekazanckripto.vercel.app/api/market/ticker/24hr?timeoutMs=5000');
  const tData = await tRes.json();
  const tryPairs = tData.data.filter(t => t.symbol.endsWith('TRY') && !t.symbol.includes('USDT'));
  
  console.log(`Found ${tryPairs.length} pairs. Testing first 5 klines...`);
  for (let i = 0; i < 5; i++) {
    const sym = tryPairs[i].symbol;
    const kRes = await fetch(`https://istekazanckripto.vercel.app/api/market/klines?symbol=${sym}&interval=1h&limit=200`);
    if (kRes.status !== 200) {
      console.log(`Failed for ${sym}: ${kRes.status}`);
    } else {
      console.log(`Success for ${sym}`);
    }
  }
}
testFullScan().catch(console.error);
