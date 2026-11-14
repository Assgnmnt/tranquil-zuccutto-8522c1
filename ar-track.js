// ar-track.js: anonymous, first-party visit and click counts for assignmentroom.com.
// No cookies, no personal data. Sends page + source + button label to
// /.netlify/functions/site-visit. Source comes from ?utm_source=, ?src=, or the
// referring site, and is remembered for the visit so a later click is tied to it.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    var src = q.get('utm_source') || q.get('src') || '';
    var camp = q.get('utm_campaign') || q.get('utm_medium') || '';
    var stored = null;
    try { stored = JSON.parse(sessionStorage.getItem('ar_src') || 'null'); } catch (e) {}
    if (!src) {
      if (stored) { src = stored.src; camp = camp || stored.camp; }
      else if (document.referrer) {
        var h = new URL(document.referrer).hostname.replace(/^www\./, '');
        src = h === location.hostname.replace(/^www\./, '') ? 'direct' : h;
      } else { src = 'direct'; }
    }
    try { sessionStorage.setItem('ar_src', JSON.stringify({ src: src, camp: camp })); } catch (e) {}

    var page = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/home';
    function send(body) {
      var s = JSON.stringify(body);
      if (navigator.sendBeacon) navigator.sendBeacon('/.netlify/functions/site-visit', new Blob([s], { type: 'application/json' }));
      else fetch('/.netlify/functions/site-visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: s, keepalive: true }).catch(function () {});
    }
    send({ ev: 'view', page: page, src: src, camp: camp });
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-track]') : null;
      if (el) send({ ev: 'click', page: page, src: src, camp: camp, label: el.getAttribute('data-track') });
    });
  } catch (e) {}
})();
