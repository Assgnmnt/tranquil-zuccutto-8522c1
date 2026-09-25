// netlify/functions/mailchimp-subscribe.js
//
// Replaces the old Zapier webhook hop for the Readiness Diagnostic.
// Called directly from diagnostic.html on submit. Creates/updates the
// contact in Mailchimp and applies the tag(s) that drive the existing
// Customer Journeys (AR-Welcome, AR-Activation, AR-Awakening,
// AR-Discernment, AR-Agreement-Barrier, AR-Detachment).
//
// Also sends Jackie a heads-up email for the higher-intent stages
// (Definition, Activation, Sustainment, Multiplication). Nothing did this
// before, so a warm lead worth a personal reach-out could sit in Mailchimp
// indefinitely with nobody knowing they were there. Awareness and Delay
// stay quiet since those are meant to be nurtured by the email sequence,
// not by a personal reply.
//
// Required environment variables (set in Netlify site config):
//   MAILCHIMP_API_KEY
//   MAILCHIMP_SERVER_PREFIX   (e.g. "us4")

const crypto = require('crypto');

const LIST_ID = '697372b43e'; // The Assignment Room audience

// Stages worth a personal look. Awareness and Delay are intentionally left
// out, they're the top of the funnel and the Mailchimp sequence is meant
// to carry those, not a notification to Jackie's inbox.
const HIGH_INTENT_STAGES = ['definition', 'activation', 'sustainment', 'multiplication'];

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

// ---- Diagnostic tracking (2026-09-25) ----
// Mailchimp stays the single client record. Every completed Diagnostic:
//   1. updates five contact fields: latest stage, first-ever stage, date
//      last taken, number of attempts, latest barrier
//   2. adds a contact note with that attempt's full result, so retakes
//      build a history and never overwrite an earlier result.
// The fields are created in the audience the first time they're needed.
// Any failure here is logged and ignored: it can never block the
// Diagnostic result or the Journey tags above.
const DIAG_FIELDS = [
  { tag: 'DIAGSTAGE', name: 'Diagnostic Stage (latest)', type: 'text' },
  { tag: 'DIAGFIRST', name: 'Diagnostic Stage (first)', type: 'text' },
  { tag: 'DIAGDATE', name: 'Diagnostic Last Taken', type: 'text' },
  { tag: 'DIAGCOUNT', name: 'Diagnostic Attempts', type: 'number' },
  { tag: 'DIAGBARR', name: 'Diagnostic Barrier (latest)', type: 'text' }
];

async function ensureDiagFields(baseUrl, authHeader) {
  const resp = await fetch(baseUrl + '/lists/' + LIST_ID + '/merge-fields?count=100&fields=merge_fields.tag', {
    headers: { Authorization: authHeader }
  });
  if (!resp.ok) throw new Error('merge-fields list failed ' + resp.status);
  const existing = ((await resp.json()).merge_fields || []).map(function (f) { return f.tag; });
  for (const f of DIAG_FIELDS) {
    if (existing.indexOf(f.tag) !== -1) continue;
    const c = await fetch(baseUrl + '/lists/' + LIST_ID + '/merge-fields', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: f.tag, name: f.name, type: f.type, public: false, required: false })
    });
    if (!c.ok) console.error('mailchimp-subscribe: could not create field', f.tag, c.status, await c.text());
  }
}

async function recordAttempt(baseUrl, authHeader, subscriberHash, info) {
  try {
    await ensureDiagFields(baseUrl, authHeader);
    const memberResp = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash + '?fields=merge_fields', {
      headers: { Authorization: authHeader }
    });
    const current = memberResp.ok ? ((await memberResp.json()).merge_fields || {}) : {};
    const count = (parseInt(current.DIAGCOUNT, 10) || 0) + 1;
    const date = (info.completedAt || new Date().toISOString()).slice(0, 10);

    const upd = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash, {
      method: 'PATCH',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_fields: {
        DIAGSTAGE: info.stage,
        DIAGFIRST: current.DIAGFIRST || info.stage,
        DIAGDATE: date,
        DIAGCOUNT: count,
        DIAGBARR: info.barrier || 'none'
      } })
    });
    if (!upd.ok) console.error('mailchimp-subscribe: field update failed', upd.status, await upd.text());

    const s = info.scores || {};
    const lines = [
      'Readiness Diagnostic, attempt ' + count + ' (' + date + ')',
      'Stage: ' + info.stage,
      'Barrier: ' + (info.barrier || 'none') + (info.tags ? ' | Tags: ' + info.tags : ''),
      'Scores: awakening ' + (s.awakening || '?') + ', clarity ' + (s.clarity || '?') + ', activation ' + (s.activation || '?') +
        ', agreements/protection ' + (s.agreements_protection || '?') + ', release/security ' + (s.release_security || '?') +
        ', precise language item ' + (s.precise_language || '?'),
      'Movement context: ' + (s.movement_context || 'n/a') + ' | Financial reality: ' + (s.financial_reality || 'n/a'),
      'Attempt ID: ' + (info.attemptId || 'n/a')
    ];
    const note = await fetch(baseUrl + '/lists/' + LIST_ID + '/members/' + subscriberHash + '/notes', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: lines.join('\n') })
    });
    if (!note.ok) console.error('mailchimp-subscribe: attempt note failed', note.status, await note.text());
  } catch (err) {
    console.error('mailchimp-subscribe: recordAttempt error', err);
  }
}

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
  //
  // Every one of the six stages now gets its own tag. Previously only
  // Activation did: Awareness, Delay, Definition, Sustainment, and
  // Multiplication all fell through to just AR-Welcome with no way to
  // tell them apart in Mailchimp. Barrier tags below still layer on
  // top of the stage tag when a barrier is present.
  const STAGE_TAG_MAP = {
    awareness: 'AR-Awareness',
    delay: 'AR-Delay',
    definition: 'AR-Definition',
    activation: 'AR-Activation',
    sustainment: 'AR-Sustainment',
    multiplication: 'AR-Multiplication'
  };

  const mcTags = ['AR-Welcome'];

  if (STAGE_TAG_MAP[stage]) mcTags.push(STAGE_TAG_MAP[stage]);
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

    // Flag the higher-intent stages for Jackie directly. This does not
    // block or slow down the response to the browser, the diagnostic page
    // is already waiting on this function, so we fire this and move on.
    if (HIGH_INTENT_STAGES.indexOf(stage) !== -1) {
      await notifyJackie({
        subject: 'High-intent diagnostic result: ' + stage + ' - ' + (firstName || email),
        alert_type: 'High-intent diagnostic',
        name: (firstName + ' ' + lastName).trim() || '(not given)',
        email: email,
        stage: stage,
        details: 'Tags: ' + mcTags.join(', ') + '. This person landed in a stage worth a personal look. Nothing is automated here on purpose.'
      });
    }

    await recordAttempt(baseUrl, authHeader, subscriberHash, {
      stage: stage,
      barrier: barrierTag,
      tags: tagsArr.join(', '),
      attemptId: String(data.attempt_id || ''),
      completedAt: String(data.completed_at || ''),
      scores: (data.scores && typeof data.scores === 'object') ? data.scores : {}
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, tags: mcTags }) };
  } catch (err) {
    console.error('mailchimp-subscribe: request error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Request to Mailchimp failed' }) };
  }
};
