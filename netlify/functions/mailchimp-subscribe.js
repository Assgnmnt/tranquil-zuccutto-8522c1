// netlify/functions/mailchimp-subscribe.js
//
// Replaces the old Zapier webhook hop for the Readiness Diagnostic.
// Called directly from diagnostic.html on submit. Creates/updates the
// contact in Mailchimp and applies the tag(s) that drive the existing
// Customer Journeys (AR-Welcome, AR-Activation, AR-Awakening,
// AR-Discernment, AR-Agreement-Barrier, AR-Detachment).
//
// Required environment variables (set in Netlify site config):
//   MAILCHIMP_API_KEY
//   MAILCHIMP_SERVER_PREFIX   (e.g. "us4")

const crypto = require('crypto');

const LIST_ID = '697372b43e'; // The Assignment Room audience

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const API_KEY = process.env.MAILCHIMP_API_KEY;
  const SERVER = process.env.MAILCHIMP_SERVER_PREFIX;

  if (!API_KEY || !SERVER) {
    console.error('mailchimp-subscribe: missing MAILCHIMP_API_KEY or MAILCHIMP_SERVER_PREFIX env var');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or missing email' }) };
  }

  const firstName = String(data.first_name || '').trim();
  const lastName = String(data.last_name || '').trim();
  const stage = String(data.stage || '').trim();
  const barrierTag = String(data.barrier_tag || '').trim();
  const tagsArr = String(data.tags || '')
    .split(',')
    .map(function (t) { return t.trim(); })
    .filter(Boolean);

  // ---- Map existing diagnostic outputs to the Mailchimp Journey trigger tags ----
  // Every one of these conditions already exists in diagnostic.html's
  // resolveStage() today. Nothing about scoring changes here, this only
  // decides which already-built email sequence a result routes to.
  const mcTags = ['AR-Welcome'];

  if (stage === 'activation') mcTags.push('AR-Activation');
  if (tagsArr.indexOf('high_stirring_low_language') !== -1) mcTags.push('AR-Awakening');
  if (tagsArr.indexOf('misaligned_momentum') !== -1) mcTags.push('AR-Discernment');
  if (barrierTag === 'agreements_protection' || tagsArr.indexOf('barrier_review') !== -1) {
    mcTags.push('AR-Agreement-Barrier');
  }
  if (barrierTag === 'release_security' || tagsArr.indexOf('barrier_review') !== -1) {
    mcTags.push('AR-Detachment');
  }

  const subscriberHash = crypto.createHash('md5').update(email).digest('hex');
  const baseUrl = 'https://' + SERVER + '.api.mailchimp.com/3.0';
  const authHeader = 'Basic ' + Buffer.from('anystring:' + API_KEY).toString('base64');

  try {
    // Create the contact if new, or update it if it already exists (upsert).
    const upsertResp = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email_address: email,
        status_if_new: 'subscribed',
        merge_fields: {
          FNAME: firstName,
          LNAME: lastName
        }
      })
    });

    if (!upsertResp.ok) {
      const errBody = await upsertResp.text();
      console.error('mailchimp-subscribe: upsert failed', upsertResp.status, errBody);
      return { statusCode: 502, body: JSON.stringify({ error: 'Mailchimp upsert failed' }) };
    }

    // Apply the tags that trigger the Journeys.
    const tagResp = await fetch(
      baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash + '/tags',
      {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tags: mcTags.map(function (name) { return { name: name, status: 'active' }; })
        })
      }
    );

    if (!tagResp.ok) {
      const errBody = await tagResp.text();
      console.error('mailchimp-subscribe: tagging failed', tagResp.status, errBody);
      return { statusCode: 502, body: JSON.stringify({ error: 'Mailchimp tagging failed' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, tags: mcTags }) };
  } catch (err) {
    console.error('mailchimp-subscribe: request error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Request to Mailchimp failed' }) };
  }
};Add mailchimp function
