// netlify/functions/assessment-signal-log.js
//
// Anonymous signal logging for the Assignment Economy Assessment's "what
// kind of help do you need next" self-select block on the results screen.
// This is a completely separate, optional layer from the assessment
// itself: the assessment stays 100% private and client-side (nothing is
// sent anywhere just from taking it). This only fires if a participant
// chooses to answer the follow-up question about what kind of help she
// needs, and even then it carries zero personally identifying information:
// no name, no email, no scope text she typed in, nothing that could be
// traced back to a specific person. Just which letter she picked, and the
// (already anonymous) diagnostic shape that produced her result.
//
// Sends one line per selection through the AR-owned alert (Netlify Forms
// "ar-alerts", emailed to jackie@assignmentroom.com).
//
// If this fails for any reason, it must never affect the participant's
// experience - the assessment page fires this fire-and-forget and ignores
// the result either way.

const LETTER_LABELS = {
  A: 'A - Need to know where I actually am / what has been holding me back',
  B: 'B - Know what I am building, have not decided to move on it',
  C: 'C - Need to get precise about what I am building and how I explain it',
  D: 'D - Understand it, need structure to execute it',
  E: 'E - Do not know if people will actually pay for this, repeatedly',
  F: 'F - Nothing right now, I know what to do next'
};

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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const letter = typeof payload.letter === 'string' ? payload.letter.trim().toUpperCase() : '';
  if (!LETTER_LABELS[letter]) {
    return { statusCode: 400, body: 'Missing or unrecognized letter' };
  }

  const assignmentCondition = typeof payload.assignmentCondition === 'string' ? payload.assignmentCondition : 'unknown';
  const testFocus = typeof payload.testFocus === 'string' ? payload.testFocus : '';
  const needsInterpretation = payload.needsInterpretation === true;

  await notifyJackie({
    subject: 'Assignment Economy Assessment - help signal: ' + letter,
    alert_type: 'Assessment help signal',
    stage: assignmentCondition,
    details: LETTER_LABELS[letter] + ' | test focus: ' + (testFocus || '(n/a)') + ' | needs interpretation: ' + (needsInterpretation ? 'yes' : 'no') + ' | Anonymous: no name or email is collected.'
  });

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
