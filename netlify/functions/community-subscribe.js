// netlify/functions/community-subscribe.js
//
// Community waitlist signup (assignmentroom.com/community).
// Deliberately separate from mailchimp-subscribe.js so a waitlist signup
// never receives a Readiness Diagnostic tag or Journey email.
// Adds the person to the AR audience with ONE tag: AR-Community-Waitlist,
// then sends Jackie an alert through the existing "ar-alerts" Netlify form.
//
// Uses the same env vars as mailchimp-subscribe.js:
//   MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX

const crypto = require('crypto');
const LIST_ID = '697372b43e';
const TAG = 'AR-Community-Waitlist';

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
    if (resp.status >= 400) console.error('community-subscribe: ar-alerts returned', resp.status);
  } catch (err) {
    console.error('community-subscribe: alert failed', err);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const API_KEY = process.env.MAILCHIMP_API_KEY;
  const SERVER = process.env.MAILCHIMP_SERVER_PREFIX;
  if (!API_KEY || !SERVER) {
    console.error('community-subscribe: missing Mailchimp env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // Honeypot: bots fill this, people never see it. Pretend success.
  if (data.company) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or missing email' }) };
  }
  const firstName = String(data.name || '').trim().slice(0, 60);

  const hash = crypto.createHash('md5').update(email).digest('hex');
  const baseUrl = 'https://' + SERVER + '.api.mailchimp.com/3.0';
  const auth = 'Basic ' + Buffer.from('anystring:' + API_KEY).toString('base64');

  try {
    // The live AR-Welcome flow (Diagnostic takers) enters every NEW contact whose
    // "Diagnostic Stage (latest)" field is blank. So a brand-new waitlist contact
    // is created with that field already set, in the SAME request, which keeps
    // them out of that flow. An EXISTING contact is never touched except to add
    // the tag, so a real Diagnostic result is never overwritten.
    const existing = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + hash + '?fields=id,status', {
      headers: { Authorization: auth }
    });
    if (existing.status !== 404 && !existing.ok) {
      console.error('community-subscribe: lookup failed', existing.status);
      return { statusCode: 502, body: JSON.stringify({ error: 'Signup failed' }) };
    }
    const isNew = existing.status === 404;
    if (isNew) {
      const up = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + hash, {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_address: email,
          status_if_new: 'subscribed',
          merge_fields: { FNAME: firstName, DIAGSTAGE: 'community-waitlist' }
        })
      });
      if (!up.ok) {
        console.error('community-subscribe: create failed', up.status, await up.text());
        return { statusCode: 502, body: JSON.stringify({ error: 'Signup failed' }) };
      }
    }
    const tg = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + hash + '/tags', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [{ name: TAG, status: 'active' }] })
    });
    if (!tg.ok) {
      console.error('community-subscribe: tagging failed', tg.status, await tg.text());
      return { statusCode: 502, body: JSON.stringify({ error: 'Signup failed' }) };
    }
    await notifyJackie({
      subject: 'New Community waitlist signup: ' + (firstName || email),
      alert_type: 'Community waitlist',
      name: firstName || '(not given)',
      email: email,
      details: 'Tagged ' + TAG + ' in Mailchimp. No Diagnostic tags applied.'
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('community-subscribe: request error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Signup failed' }) };
  }
};
