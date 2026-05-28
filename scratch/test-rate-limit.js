const https = require('https');

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(path, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function testRateLimit() {
  const symbol = 'XRPTRY';
  let success = 0;
  let fails = 0;
  
  console.log(`Testing 20 concurrent requests to Vercel klines endpoint...`);
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(get(`https://istekazanckripto.vercel.app/api/market/klines?symbol=${symbol}&interval=1h&limit=200`));
  }
  
  const results = await Promise.all(promises);
  for (const r of results) {
    if (r.status === 200) success++;
    else {
      fails++;
      console.log(`Fail ${r.status}: ${r.data.slice(0, 50)}`);
    }
  }
  
  console.log(`Success: ${success}, Fails: ${fails}`);
}

testRateLimit().catch(console.error);
