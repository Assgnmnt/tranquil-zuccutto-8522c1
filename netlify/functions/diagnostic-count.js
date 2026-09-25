// netlify/functions/diagnostic-count.js
//
// Anonymous Readiness Diagnostic completion count (2026-09-25).
// diagnostic.html sends two events with no name, email or answers:
//   "finished"  - she answered every question and reached the email step
//   "submitted" - she entered her email and saw her result
// Totals and per-stage counts live in Netlify Blobs, store
// "diagnostic-stats", key "counts" (Netlify > Data & storage > Blobs).
// The gap between finished and submitted shows how many women finish
// but don't leave an email.

const { getStore, connectLambda } = require('@netlify/blobs');

const EVENTS = ['finished', 'submitted'];
const STAGES = ['awareness', 'delay', 'definition', 'activation', 'sustainment', 'multiplication'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let data = {};
  try { data = JSON.parse(event.body || '{}'); } catch (e) {}
  const name = EVENTS.indexOf(data.event) !== -1 ? data.event : null;
  if (!name) return { statusCode: 400, body: 'Unknown event' };
  const stage = STAGES.indexOf(data.stage) !== -1 ? data.stage : 'unknown';

  try {
    connectLambda(event);
    const store = getStore('diagnostic-stats');
    const counts = (await store.get('counts', { type: 'json' })) || { since: new Date().toISOString().slice(0, 10) };
    const month = new Date().toISOString().slice(0, 7);
    counts[name] = counts[name] || { total: 0, byStage: {}, byMonth: {} };
    counts[name].total += 1;
    counts[name].byStage[stage] = (counts[name].byStage[stage] || 0) + 1;
    counts[name].byMonth[month] = (counts[name].byMonth[month] || 0) + 1;
    counts.updated = new Date().toISOString();
    await store.setJSON('counts', counts);
  } catch (err) {
    console.error('diagnostic-count: failed', err);
  }
  return { statusCode: 204, body: '' };
};
