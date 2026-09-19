// netlify/functions/workshop-seats.js
//
// Live seat count for the Assignment Economy page. Reads completed, paid
// checkouts on the $47 Founding Workshop payment link from Stripe and returns
// the seats left plus recent buyers' FIRST NAMES only (no city, no email).
//
// SETUP: Netlify > Site configuration > Environment variables, add
// STRIPE_SEATS_KEY = a Stripe RESTRICTED key (starts with "rk_live_") with
// read-only access to "Checkout Sessions" and nothing else.
//
// If the key is missing or Stripe is unreachable, this returns a 503 and the
// page keeps showing its built-in fallback numbers.

const PAYMENT_LINK = 'plink_1UG6toFGAdsHSJ1n3xJ42sfD'; // $47 Founding Workshop
const CAP = 50;

exports.handler = async function () {
  const key = process.env.STRIPE_SEATS_KEY;
  if (!key) return { statusCode: 503, body: JSON.stringify({ error: 'not configured' }) };

  try {
    const sessions = [];
    let startingAfter = null;
    for (let page = 0; page < 5; page++) {
      const url = new URL('https://api.stripe.com/v1/checkout/sessions');
      url.searchParams.set('payment_link', PAYMENT_LINK);
      url.searchParams.set('status', 'complete');
      url.searchParams.set('limit', '100');
      if (startingAfter) url.searchParams.set('starting_after', startingAfter);
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
      if (!res.ok) throw new Error('stripe ' + res.status);
      const json = await res.json();
      sessions.push.apply(sessions, json.data);
      if (!json.has_more) break;
      startingAfter = json.data[json.data.length - 1].id;
    }

    const paid = sessions.filter(function (s) { return s.payment_status === 'paid'; });
    const buyers = paid.slice(0, 8).map(function (s) {
      const name = ((s.customer_details && s.customer_details.name) || '').trim();
      const first = name.split(/\s+/)[0];
      // Buyer preference: this buyer goes by her middle name.
      return first === 'Shameka' ? 'Michelle' : first;
    }).filter(Boolean);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
      body: JSON.stringify({ cap: CAP, sold: paid.length, left: Math.max(CAP - paid.length, 0), buyers: buyers }),
    };
  } catch (e) {
    return { statusCode: 503, body: JSON.stringify({ error: 'unavailable' }) };
  }
};
