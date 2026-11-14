// netlify/functions/site-visit.js
//
// Anonymous visit and click counts (2026-11-14). Same idea as
// diagnostic-count.js: no cookies, no IP address, no names, no emails.
// ar-track.js sends one small event per page view and one per tracked
// button click: which page, which source (utm_source, a ?src= tag, or
// the referring site), and which button. Totals live in Netlify Blobs,
// store "site-stats", key "counts".
//
// GET returns the summary only when SITE_STATS_KEY is set in Netlify and
// the request carries ?key= with the same value.

const { getStore, connectLambda } = require('@netlify/blobs');

const EVENTS = ['view', 'click'];

function clean(v, max) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9._\-\/ ]/g, '').trim().slice(0, max || 40);
}

function bump(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    const secret = process.env.SITE_STATS_KEY;
    const given = (event.queryStringParameters || {}).key;
    if (!secret || given !== secret) return { statusCode: 404, body: 'Not found' };
    try {
      connectLambda(event);
      const store = getStore('site-stats');
      const counts = (await store.get('counts', { type: 'json' })) || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(counts, null, 2) };
    } catch (err) {
      return { statusCode: 500, body: 'Error' };
    }
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const ua = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '';
  if (/bot|crawl|spider|preview|headless/i.test(ua)) return { statusCode: 204, body: '' };

  let data = {};
  try { data = JSON.parse(event.body || '{}'); } catch (e) {}
  if (EVENTS.indexOf(data.ev) === -1) return { statusCode: 400, body: 'Unknown event' };

  const page = clean(data.page, 60) || 'unknown';
  const src = clean(data.src, 40) || 'direct';
  const camp = clean(data.camp, 40);
  const label = clean(data.label, 40) || 'unlabeled';
  const month = new Date().toISOString().slice(0, 7);

  try {
    connectLambda(event);
    const store = getStore('site-stats');
    const c = (await store.get('counts', { type: 'json' })) || { since: new Date().toISOString().slice(0, 10) };
    ['views', 'clicks', 'viewsBySource', 'viewsByPage', 'clicksByLabel', 'clicksBySource', 'byMonth', 'byCampaign'].forEach(function (k) {
      c[k] = c[k] || (k === 'views' || k === 'clicks' ? 0 : {});
    });
    if (data.ev === 'view') {
      c.views += 1;
      bump(c.viewsBySource, src);
      bump(c.viewsByPage, page);
      bump(c.byMonth, month + ' views');
      if (camp) bump(c.byCampaign, src + ' / ' + camp);
    } else {
      c.clicks += 1;
      bump(c.clicksByLabel, label);
      bump(c.clicksBySource, label + ' from ' + src);
      bump(c.byMonth, month + ' clicks');
    }
    c.updated = new Date().toISOString();
    await store.setJSON('counts', c);
  } catch (err) {
    console.error('site-visit: failed', err);
  }
  return { statusCode: 204, body: '' };
};
