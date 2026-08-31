// netlify/functions/payhip-webhook.js
//
// Connects Payhip purchases (currently just the Discernment Report™, $97)
// to Mailchimp and to Jackie's inbox. Before this, someone could buy the
// report and vanish from every system: Payhip has the receipt, nothing
// else knows they exist, no nurture sequence, no record, no notification.
//
// SETUP — two steps, both in your own dashboards, not in code:
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

  // Verify this actually came from Payhip, when a key is configured.
  // Payhip's own spec: signature = sha256(your Payhip API key).
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

  // Only act on completed purchases. Refunds/subscription events are
  // ignored for now, there's nothing on Payhip beyond the one-time
  // Discernment Report sale today.
  if (data.type !== 'paid') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: data.type || 'unknown event' }) };
  }

  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('payhip-webhook: missing/invalid email on paid event', data.id);
    return { statusCode: 400, body: 'Missing or invalid email' };
  }

  // Payhip's paid event does not include a name, only email.
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

  // A new, dedicated tag, kept separate from the diagnostic's AR-Discernment
  // tag (which means something different: "misaligned momentum" from the
  // quiz, not "bought the report"). Build a Mailchimp Automation off this
  // tag whenever you're ready to nurture these buyers toward a next step.
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

    // Payhip's own receipt email goes to the buyer, not to Jackie. This is
    // the only place she'd otherwise learn a sale happened.
    fetch('https://formspree.io/hello@assignmentroom.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: 'Discernment Report sale — ' + email,
        email: email,
        product: productNames.join(', ') || 'Discernment Report',
        amount: amount
      })
    }).catch(function (err) {
      console.error('payhip-webhook: sale notification failed', err);
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, tags: mcTags }) };
  } catch (err) {
    console.error('payhip-webhook: request error', err);
    return { statusCode: 500, body: 'Request to Mailchimp failed' };
  }
};
