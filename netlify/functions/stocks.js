// Server-side proxy for US stock candles: Yahoo Finance first, Stooq as a fallback (daily/weekly only).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try { return await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': '*/*' } }); } finally { clearTimeout(t); }
}
const nf = (m) => Object.assign(new Error(m), { nf: true });
async function yahoo(sym, tf) {
  const range = { '1d': '5y', '1wk': 'max', '60m': '730d' }[tf];
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await get('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=' + tf + '&range=' + range + '&includePrePost=false');
      if (r.status === 404) throw nf('Not found');
      if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
      const j = await r.json();
      if (j.chart && j.chart.error) throw nf(j.chart.error.description || 'Yahoo error');
      const res = j.chart.result[0], ts = res.timestamp || [], q = res.indicators.quote[0], c = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open[i], h = q.high[i], l = q.low[i], cl = q.close[i];
        if (o == null || h == null || l == null || cl == null) continue;
        c.push([ts[i] * 1000, o, h, l, cl, q.volume[i] || 0]);
      }
      if (c.length < 2) throw nf('No data');
      const p = res.meta && res.meta.currentTradingPeriod && res.meta.currentTradingPeriod.regular, now = Date.now() / 1000;
      return { candles: c, open: p ? now >= p.start && now < p.end : true, source: 'Yahoo Finance' };
    } catch (e) { lastErr = e; if (e.nf) throw e; }
  }
  throw lastErr;
}
async function stooq(sym, tf) {
  if (tf === '60m') throw new Error('Stooq has no hourly data');
  const r = await get('https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym.toLowerCase().replace('.', '-')) + '.us&i=' + (tf === '1wk' ? 'w' : 'd'));
  const lines = (await r.text()).trim().split(/\r?\n/);
  if (!/^Date,Open/i.test(lines[0])) throw nf('No data');
  const c = lines.slice(1).map(L => { const p = L.split(','); return [Date.parse(p[0] + 'T00:00:00Z'), +p[1], +p[2], +p[3], +p[4], +(p[5] || 0)]; }).filter(x => x.slice(0, 5).every(Number.isFinite));
  return { candles: c, open: true, source: 'Stooq' };
}
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const sym = String(q.symbol || '').toUpperCase().trim(), tf = String(q.tf || '1d');
  const json = (statusCode, body, extra) => ({ statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, extra || {}), body: JSON.stringify(body) });
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(sym)) return json(400, { error: 'Invalid symbol' });
  if (!['1d', '1wk', '60m'].includes(tf)) return json(400, { error: 'Invalid interval' });
  const N = Math.min(720, Math.max(50, parseInt(q.n, 10) || 300));
  let out, err;
  try { out = await yahoo(sym, tf); } catch (e) { err = e; }
  if (!out) {
    try { out = await stooq(sym, tf); }
    catch (e2) {
      if (err && err.nf && (e2.nf || tf === '60m')) return json(404, { error: 'Symbol not found' });
      return json(502, { error: (err ? err.message : '') + ' / ' + e2.message });
    }
  }
  const c = out.candles.slice(-N);
  // When the market is closed the last candle is final; add a placeholder "live" candle so the page analyses every finished candle.
  if (!out.open && tf !== '1wk') { const last = c[c.length - 1]; c.push([last[0] + (tf === '1d' ? 86400000 : 3600000), last[4], last[4], last[4], last[4], 0]); }
  return json(200, { symbol: sym, source: out.source, marketOpen: out.open, asof: Date.now(), candles: c }, { 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': 'public, max-age=300' });
};
