// netlify/functions/payhip-webhook.js
//
// Connects Payhip purchases (currently just the Discernment Report, $97)
// to Mailchimp and to Jackie's inbox. Before this, someone could buy the
// report and vanish from every system: Payhip has the receipt, nothing
// else knows they exist, no nurture sequence, no record, no notification.
//
// SETUP - two steps, both in your own dashboards, not in code:
//
// 1. Payhip: Settings > Developer > Webhooks. Paste this function's live
//    URL (https://assignmentroom.com/.netlify/functions/payhip-webhook)
//    and select the "paid" event.
//
// 2. Netlify: Site configuration > Environment variables. Add PAYHIP_API_KEY
//    using the API key shown on that same Payhip Settings > Developer page.
//    This lets the function verify a request actually came from Payhip
//    instead of trusting any POST that shows up at this URL. If you skip
//    this, the function still works, it just can't verify the sender.
//
// Payhip's webhook payload format verified against their published docs
// (help.payhip.com/article/115-webhooks) on 2026-08-31.

const crypto = require('crypto');

const LIST_ID = '697372b43e'; // The Assignment Room audience

// AR-owned alerts (2026-09-25). Every heads-up to Jackie now goes to the
// Netlify Forms form "ar-alerts" on assignmentroom.com (hidden form in
// ar-alerts.html). Netlify emails each submission to
// jackie@assignmentroom.com (Netlify > Forms > Form notifications).
// This replaces the DeepSight / Fully Staffing Formspree form (mqevpdbl)
// and the formspree.io/hello@ endpoint, which was never activated.
// Awaited with a short timeout so the call finishes before the function
// returns, and it can never fail the request it rides on.
async function notifyJackie(fields) {
  try {
    const params = new URLSearchParams();
    params.append('form-name', 'ar-alerts');
    Object.keys(fields).forEach(function (k) { params.append(k, fields[k] == null ? '' : String(fields[k])); });
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 3000);
    const resp = await fetch('https://assignmentroom.com/ar-alerts.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual',
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (resp.status >= 400) console.error('notifyJackie: ar-alerts returned', resp.status);
  } catch (err) {
    console.error('notifyJackie: alert failed', err);
  }
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
          return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let data;
    try {
          data = JSON.parse(event.body || '{}');
    } catch (e) {
          console.error('payhip-webhook: invalid JSON body');
          return { statusCode: 400, body: 'Invalid JSON' };
    }

    const PAYHIP_KEY = process.env.PAYHIP_API_KEY;
    if (PAYHIP_KEY) {
        const expected = crypto.createHash('sha256').update(PAYHIP_KEY).digest('hex');
        if (data.signature !== expected) {
            console.error('payhip-webhook: signature mismatch, ignoring request');
            return { statusCode: 401, body: 'Invalid signature' };
        }
    } else {
        console.warn('payhip-webhook: PAYHIP_API_KEY not set, skipping signature verification');
    }

    if (data.type !== 'paid') {
        return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: data.type || 'unknown event' }) };
    }

    const email = String(data.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        console.error('payhip-webhook: missing/invalid email on paid event', data.id);
        return { statusCode: 400, body: 'Missing or invalid email' };
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const productNames = items.map(function (i) { return i && i.product_name; }).filter(Boolean);
    const amount = typeof data.price === 'number' ? '$' + (data.price / 100).toFixed(2) : 'unknown';

    const API_KEY = process.env.MAILCHIMP_API_KEY;
    const SERVER = process.env.MAILCHIMP_SERVER_PREFIX;
    if (!API_KEY || !SERVER) {
        console.error('payhip-webhook: missing MAILCHIMP_API_KEY or MAILCHIMP_SERVER_PREFIX env var');
        return { statusCode: 500, body: 'Server not configured' };
    }

    const subscriberHash = crypto.createHash('md5').update(email).digest('hex');
    const baseUrl = 'https://' + SERVER + '.api.mailchimp.com/3.0';
    const authHeader = 'Basic ' + Buffer.from('anystring:' + API_KEY).toString('base64');

    const mcTags = ['AR-Welcome', 'AR-Report-Purchased'];

    try {
        const upsertResp = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash, {
            method: 'PUT',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email_address: email, status_if_new: 'subscribed' })
        });

    if (!upsertResp.ok) {
        const errBody = await upsertResp.text();
        console.error('payhip-webhook: upsert failed', upsertResp.status, errBody);
        return { statusCode: 502, body: 'Mailchimp upsert failed' };
    }

    const tagResp = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash + '/tags', {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: mcTags.map(function (name) { return { name: name, status: 'active' }; }) })
    });

    if (!tagResp.ok) {
        const errBody = await tagResp.text();
        console.error('payhip-webhook: tagging failed', tagResp.status, errBody);
        return { statusCode: 502, body: 'Mailchimp tagging failed' };
    }

    await notifyJackie({
        subject: 'Discernment Report sale - ' + email,
        alert_type: 'Discernment Report sale',
        email: email,
        amount: amount,
        details: productNames.join(', ') || 'Discernment Report'
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, tags: mcTags }) };
    } catch (err) {
        console.error('payhip-webhook: request error', err);
        return { statusCode: 500, body: 'Request to Mailchimp failed' };
    }
};
