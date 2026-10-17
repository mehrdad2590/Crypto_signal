exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const coin = String(q.coin || 'BTC').toUpperCase();
  const interval = String(q.interval || '60');
  const json = (statusCode, body, extra) => ({ statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, extra || {}), body: JSON.stringify(body) });
  if (!/^[A-Z0-9]{2,10}$/.test(coin)) return json(400, { error: 'Invalid symbol' });
  if (!['15', '60', '240', '1440', '10080'].includes(interval)) return json(400, { error: 'Invalid interval' });
  const N = Math.min(720, Math.max(50, parseInt(q.n, 10) || 300));
  const pairs = coin === 'BTC' ? ['XBTUSD'] : coin === 'DOGE' ? ['XDGUSD', 'DOGEUSD'] : [coin + 'USD'];
  let lastErr = 'Market unavailable', notFound = false;
  for (const pair of pairs) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch('https://api.kraken.com/0/public/OHLC?pair=' + pair + '&interval=' + interval, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('Upstream HTTP ' + r.status);
      const x = await r.json();
      if (x.error && x.error.length) { notFound = /Unknown asset pair/i.test(x.error.join(' ')); throw new Error(x.error.join(', ')); }
      const key = Object.keys(x.result).find(k => k !== 'last');
      const rows = x.result[key];
      if (!rows || !rows.length) throw new Error('Empty market data');
      const candles = rows.slice(-N).map(c => [c[0] * 1000, +c[1], +c[2], +c[3], +c[4], +c[6]]);
      return json(200, { coin, source: 'Kraken', asof: Date.now(), candles }, { 'Cache-Control': 'public, max-age=30', 'Netlify-CDN-Cache-Control': 'public, max-age=30' });
    } catch (e) { clearTimeout(timer); lastErr = e.message; }
  }
  return json(notFound ? 404 : 502, { error: lastErr });
};
