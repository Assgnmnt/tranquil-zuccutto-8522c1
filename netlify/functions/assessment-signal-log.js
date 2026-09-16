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
// Reuses the exact notification pattern already proven in
// stripe-workshop-webhook.js: a plain fetch to Formspree's email-forwarding
// endpoint, no API key, no new dependency, no new infrastructure to trust.
// Jackie sees these land in the same hello@assignmentroom.com inbox she
// already checks, one line per selection.
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

  try {
    // FIX (2026-09-16, part 2): the classic https://formspree.io/{email}
    // endpoint was never fully activated on Jackie's Formspree account
    // ("This form isn't set up yet" / FORM_NOT_FOUND), even after the
    // Referer fix below. Jackie confirmed the real, active form ID from her
    // Formspree dashboard (mqevpdbl) - switching to the form-ID endpoint,
    // which is the one Formspree actually expects server-to-server calls to
    // use.
    const resp = await fetch('https://formspree.io/f/mqevpdbl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // A server-to-server call has no browser Referer, and Formspree's
        // domain check rejects that with "Invalid Referer header" (caught
        // live while testing this function - see also the note in
        // stripe-workshop-webhook.js, which hits the same endpoint the same
        // way and should get this same header added). Setting these to the
        // site's own origin satisfies Formspree's allowed-domain check.
        Referer: 'https://assignmentroom.com/',
        Origin: 'https://assignmentroom.com'
      },
      body: JSON.stringify({
        _subject: 'Assignment Economy Assessment - help signal: ' + letter,
        need_selected: LETTER_LABELS[letter],
        assignment_condition: assignmentCondition,
        test_focus: testFocus || '(n/a)',
        needs_interpretation: needsInterpretation ? 'yes' : 'no',
        note: 'Anonymous - no name, email, or identifying detail is collected by this form.'
      })
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('assessment-signal-log: formspree failed', resp.status, errBody);
      // Still 200 to the caller - a failed notification should never surface
      // as an error to the participant, who never sees this call at all.
    }
  } catch (err) {
    console.error('assessment-signal-log: request error', err);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
