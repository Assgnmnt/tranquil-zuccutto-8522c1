// netlify/functions/stripe-workshop-webhook.js
//
// Connects a completed Assignment Economy Workshop purchase (Stripe Payment
// Link, $47) to Mailchimp, the same way payhip-webhook.js already does for
// the Discernment Report. Without this, Stripe has the payment and nobody
// else knows the person exists: no confirmation email, no record in
// Mailchimp, no heads-up to Jackie.
//
// SETUP - three steps, all outside this file:
//
// 1. Stripe: a webhook endpoint already exists, listening for the
//    "checkout.session.completed" event, pointing at this function's live
//    URL: https://assignmentroom.com/.netlify/functions/stripe-workshop-webhook
//
// 2. Netlify: Site configuration > Environment variables. Add
//    STRIPE_WEBHOOK_SECRET using the signing secret Stripe shows for that
//    webhook endpoint (starts with "whsec_"). MAILCHIMP_API_KEY and
//    MAILCHIMP_SERVER_PREFIX are already set on this site from the
//    diagnostic/report integrations, this function reuses them.
//
// 3. Mailchimp app: an Automation triggered by the tag
//    "AR-Workshop-Purchased" being added to a contact sends the actual
//    confirmation email. This function's only job is to apply that tag
//    the moment Stripe confirms payment.

const crypto = require('crypto');

const LIST_ID = '697372b43e'; // The Assignment Room audience

// Verifies the request really came from Stripe. Stripe's signature scheme:
// header looks like "t=<timestamp>,v1=<hex signature>", and the signature
// is HMAC-SHA256 of "<timestamp>.<raw body>" using the webhook secret.
// Same manual-verification approach as payhip-webhook.js uses for Payhip's
// signature, just Stripe's specific format.
function verifyStripeSignature(rawBody, sigHeader, secret) {
    if (!sigHeader) return false;
    const parts = {};
    sigHeader.split(',').forEach(function (part) {
          const idx = part.indexOf('=');
          if (idx === -1) return;
          parts[part.slice(0, idx)] = part.slice(idx + 1);
    });
    if (!parts.t || !parts.v1) return false;

  const signedPayload = parts.t + '.' + rawBody;
    const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  try {
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
  } catch (e) {
        return false; // length mismatch etc. - treat as not verified
  }
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
          return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
    const rawBody = event.body || '';

    if (WEBHOOK_SECRET) {
          const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
          if (!verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET)) {
                  console.error('stripe-workshop-webhook: signature verification failed, ignoring request');
                  return { statusCode: 401, body: 'Invalid signature' };
          }
    } else {
          console.warn('stripe-workshop-webhook: STRIPE_WEBHOOK_SECRET not set, skipping signature verification');
    }

    let stripeEvent;
    try {
          stripeEvent = JSON.parse(rawBody);
    } catch (e) {
          console.error('stripe-workshop-webhook: invalid JSON body');
          return { statusCode: 400, body: 'Invalid JSON' };
    }

    if (stripeEvent.type !== 'checkout.session.completed') {
          return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: stripeEvent.type || 'unknown event' }) };
    }

    const session = (stripeEvent.data && stripeEvent.data.object) || {};
    const details = session.customer_details || {};

    const email = String(details.email || session.customer_email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          console.error('stripe-workshop-webhook: missing/invalid email on completed session', session.id);
          return { statusCode: 400, body: 'Missing or invalid email' };
    }

    const fullName = String(details.name || '').trim();
    const firstName = fullName ? fullName.split(' ')[0] : '';
    const lastName = fullName.split(' ').slice(1).join(' ');
    const amount = typeof session.amount_total === 'number' ? '$' + (session.amount_total / 100).toFixed(2) : 'unknown';

    const API_KEY = process.env.MAILCHIMP_API_KEY;
    const SERVER = process.env.MAILCHIMP_SERVER_PREFIX;
    if (!API_KEY || !SERVER) {
          console.error('stripe-workshop-webhook: missing MAILCHIMP_API_KEY or MAILCHIMP_SERVER_PREFIX env var');
          return { statusCode: 500, body: 'Server not configured' };
    }

    const subscriberHash = crypto.createHash('md5').update(email).digest('hex');
    const baseUrl = 'https://' + SERVER + '.api.mailchimp.com/3.0';
    const authHeader = 'Basic ' + Buffer.from('anystring:' + API_KEY).toString('base64');

    // AR-Workshop-Purchased is the trigger tag for the Mailchimp Automation
    // that actually sends the confirmation email (built in the Mailchimp
    // app - see setup note above, this file only applies the tag).
    const mcTags = ['AR-Welcome', 'AR-Workshop-Purchased'];

    try {
          const upsertResp = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash, {
                  method: 'PUT',
                  headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                            email_address: email,
                            status_if_new: 'subscribed',
                            merge_fields: { FNAME: firstName, LNAME: lastName }
                  })
          });

      if (!upsertResp.ok) {
              const errBody = await upsertResp.text();
              console.error('stripe-workshop-webhook: upsert failed', upsertResp.status, errBody);
              return { statusCode: 502, body: 'Mailchimp upsert failed' };
      }

      const tagResp = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash + '/tags', {
              method: 'POST',
              headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
              body: JSON.stringify({ tags: mcTags.map(function (name) { return { name: name, status: 'active' }; }) })
      });

      if (!tagResp.ok) {
              const errBody = await tagResp.text();
              console.error('stripe-workshop-webhook: tagging failed', tagResp.status, errBody);
              return { statusCode: 502, body: 'Mailchimp tagging failed' };
      }

      // Heads-up to Jackie for every paid seat, same pattern as the
      // Discernment Report notification. Doesn't block the response.
      fetch('https://formspree.io/hello@assignmentroom.com', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({
                        _subject: 'Assignment Economy Workshop seat sold - ' + (fullName || email),
                        name: fullName || '(not given)',
                        email: email,
                        amount: amount
              })
      }).catch(function (err) {
              console.error('stripe-workshop-webhook: sale notification failed', err);
      });

      return { statusCode: 200, body: JSON.stringify({ ok: true, tags: mcTags }) };
    } catch (err) {
          console.error('stripe-workshop-webhook: request error', err);
          return { statusCode: 500, body: 'Request to Mailchimp failed' };
    }
};
