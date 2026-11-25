/*
 * 拾影 — YouTube PO Token (proof-of-origin) generator, runs in a hidden WebView whose page origin is https://www.youtube.com
 * (loadDataWithBaseURL), so fetches to youtube.com are same-origin and carry the WebView's YouTube cookies.
 *
 * Flow (same as the real site / bgutils-js):
 *   homepage → ytcfg (VISITOR_DATA, DATASYNC_ID) + BotGuard challenge (window.ytAtN, fallback /youtubei/v1/att/get)
 *   → load the BotGuard interpreter → run program → snapshot → GenerateIT (jnn-pa.googleapis.com) → integrity token
 *   → webPoSignalOutput[0](integrityToken) = minter → mint(contentBinding) for each binding yt-dlp may ask for.
 *
 * Written for 拾影 after the algorithm of bgutils-js by LuanRT (MIT License, https://github.com/LuanRT/BgUtils);
 * no code copied from GPL projects (bgutil-ytdlp-pot-provider / NewPipe were only read for reference; the app is GPL-3.0 anyway).
 */
(function () {
  'use strict';
  var REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
  var API_KEY = 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw';
  var GENERATE_IT = 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT';

  function b64ToU8(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=');
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function u8ToB64Url(u) {
    var s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
  }
  function withTimeout(p, ms, what) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(what + ' timeout')); }, ms); })]);
  }
  function jsStr(inner) { // decode a single-quoted JS string literal body (\xNN, \', \uNNNN, \\ ...)
    var t = inner.replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1').replace(/\\'/g, "'").replace(/"/g, '\\"').replace(/\\\\"/g, '\\"');
    return JSON.parse('"' + t + '"');
  }
  function attChallenge(html) { // window.ytAtN({'R': '<json as JS string>'})
    var a = html.match(/window\.ytAtN\(\s*\{\s*'R'\s*:\s*'((?:[^'\\]|\\[\s\S])*)'/);
    if (!a) return null;
    var d = JSON.parse(jsStr(a[1]));
    return d && d.bgChallenge || null;
  }
  function loadScript(url) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.onload = function () { res(); }; s.onerror = function () { rej(new Error('interpreter load failed')); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function challengeAndConfig(log) {
    var cfg = {}, challenge = null;
    try {
      var html = await (await fetch('https://www.youtube.com/', { credentials: 'include' })).text();
      var m = html.match(/ytcfg\.set\(({.+?})\);/s);
      if (m) { try { cfg = JSON.parse(m[1]); } catch (e) {} }
      try { challenge = attChallenge(html); } catch (e) { log('ytAtN parse: ' + e); }
      log('homepage ' + (m ? 'cfg' : 'nocfg') + ' ' + (challenge ? 'challenge' : 'nochallenge'));
    } catch (e) { log('homepage failed: ' + e); }
    window.yt = window.yt || {}; window.yt.config_ = cfg; // BotGuard reads yt.config_.EVENT_ID
    if (!challenge) {
      var r = await fetch('https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: (cfg.INNERTUBE_CONTEXT || { client: { clientName: 'WEB', clientVersion: cfg.INNERTUBE_CLIENT_VERSION || '2.20261120.01.00' } }),
          engagementType: 'ENGAGEMENT_TYPE_UNBOUND' })
      });
      var j = await r.json();
      challenge = j && j.bgChallenge;
      log('att/get ' + (challenge ? 'ok' : 'empty'));
    }
    if (!challenge || !challenge.program) throw new Error('no BotGuard challenge');
    return { cfg: cfg, challenge: challenge };
  }

  async function makeMinter(challenge, log) {
    var iu = challenge.interpreterUrl;
    var url = (iu && (iu.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || iu)) || '';
    if (typeof url !== 'string' || !url) throw new Error('no interpreter url');
    if (url.indexOf('//') === 0) url = 'https:' + url;
    if (!window[challenge.globalName]) await withTimeout(loadScript(url), 15000, 'interpreter');
    var vm = window[challenge.globalName];
    if (!vm || !vm.a) throw new Error('BotGuard VM unavailable');
    var fns = await withTimeout(new Promise(function (res) {
      vm.a(challenge.program, function (asyncSnapshot, shutdown, passEvent, checkCamera) { res({ snap: asyncSnapshot }); },
        true, undefined, function () {}, [[], []], undefined, false,
        [function () {}, function () {}, function () {}, function () {}, function () {}]);
    }), 10000, 'vm init');
    var out = [];
    var bgResponse = await withTimeout(new Promise(function (res) { fns.snap(function (r) { res(r); }, [undefined, undefined, out, undefined]); }), 10000, 'snapshot');
    log('snapshot ' + (bgResponse ? bgResponse.length : 0));
    var r = await fetch(GENERATE_IT, {
      method: 'POST',
      headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': API_KEY, 'x-user-agent': 'grpc-web-javascript/0.1' },
      body: JSON.stringify([REQUEST_KEY, bgResponse])
    });
    var it = await r.json();
    if (!it || !it[0]) throw new Error('GenerateIT failed: ' + JSON.stringify(it).slice(0, 120));
    if (!out[0]) throw new Error('no minter factory');
    var mint = await out[0](b64ToU8(it[0]));
    if (typeof mint !== 'function') throw new Error('minter unavailable');
    log('integrity ttl ' + it[1]);
    return { mint: mint, ttl: it[1] || 21600 };
  }

  /** bindings: video ids. Resolves to {visitorData, dataSyncId, ttl, tokens:{binding:token}, log}. */
  window.shiyingPot = async function (videoIds) {
    var logs = [];
    function log(s) { logs.push(String(s)); }
    try {
      var cc = await challengeAndConfig(log);
      var cfg = cc.cfg;
      var visitor = cfg.VISITOR_DATA || (cfg.INNERTUBE_CONTEXT && cfg.INNERTUBE_CONTEXT.client && cfg.INNERTUBE_CONTEXT.client.visitorData) || '';
      var dsid = cfg.DATASYNC_ID || '';
      if (dsid.indexOf('||') >= 0) dsid = dsid.split('||')[0];
      var m = await makeMinter(cc.challenge, log);
      var bindings = (videoIds || []).slice();
      if (visitor) bindings.push(visitor);
      if (dsid) bindings.push(dsid);
      var tokens = {};
      for (var i = 0; i < bindings.length; i++) {
        var t = await m.mint(new TextEncoder().encode(bindings[i]));
        if (t instanceof Uint8Array) tokens[bindings[i]] = u8ToB64Url(t);
      }
      return JSON.stringify({ ok: true, visitorData: visitor, dataSyncId: dsid, loggedIn: !!cfg.LOGGED_IN, ttl: m.ttl, tokens: tokens, log: logs });
    } catch (e) {
      log(e && e.message ? e.message : String(e));
      return JSON.stringify({ ok: false, error: String(e && e.message || e), log: logs });
    }
  };
})();
