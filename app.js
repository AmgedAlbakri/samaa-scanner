/* SAMAA MAJU Scanner — client logic
 * Vanilla JS. Talks to the Apps Script Web App via "simple" text/plain POSTs
 * (no CORS preflight). All product/user values are rendered with textContent.
 */
(function () {
  'use strict';

  var CFG  = window.SAMAA_CONFIG;
  var KEYS = CFG.STORAGE_KEYS;
  var $    = function (id) { return document.getElementById(id); };

  // ── session state ──────────────────────────────────────────────────────────
  var token = localStorage.getItem(KEYS.token) || null;
  var user  = safeParse(localStorage.getItem(KEYS.user)) || null;

  // Stable per-device id for the one-time enrollment gate. Generated once and kept
  // in localStorage; sent with every request so the server can bind a device to a
  // user and block abusive devices. (Clearing browser data yields a new id — by
  // design the device then needs a fresh admin-issued code.)
  var deviceId = localStorage.getItem(KEYS.device) || '';
  if (!deviceId) {
    deviceId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(KEYS.device, deviceId); } catch (e) {}
  }

  // in-memory caches
  var allProducts = [];          // for Products screen + search
  var barcodeIndex = {};         // barcode -> product, for INSTANT local lookups
  var productsLoaded = false;
  var sessionScans = [];         // current Scan-screen session (newest first)
  var scanLog = safeParse(localStorage.getItem(KEYS.log)) || []; // persistent

  // ── validation (mirrors server §4.2) ───────────────────────────────────────
  var RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var RE_USER  = /^[A-Za-z0-9 ._-]{2,30}$/;

  // ════════════════════════════════════════════════════════════════════════
  //  API
  // ════════════════════════════════════════════════════════════════════════
  function api(action, params) {
    if (!CFG.WEB_APP_URL) {
      return Promise.resolve({ ok: false, reason: 'no_config', _client: true });
    }
    var payload = Object.assign({ action: action, deviceId: deviceId }, params || {});
    if (token && action !== 'login') payload.sessionToken = token;
    return fetch(CFG.WEB_APP_URL, {
      method: 'POST',
      // text/plain → "simple request", avoids the CORS preflight Apps Script can't answer (§3.2)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.text(); })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, reason: 'bad_response', _client: true }; } })
      .catch(function () { return { ok: false, reason: 'network', _client: true }; });
  }

  // any authenticated call may report the session died → bounce out.
  //   inactive       → admin unchecked "Active" → log out with a clear message
  //   device_revoked → this device was un-enrolled → log out and re-gate to enroll
  //   unauthorized   → expired/invalid session
  function handleUnauthorized(res) {
    if (!res) return false;
    if (res.reason === 'inactive') { doLogout('Your account has been deactivated — contact admin.'); return true; }
    if (res.reason === 'device_revoked') { doLogout('This device is no longer authorized.'); return true; }
    if (res.reason === 'unauthorized') { doLogout('Session expired — please log in again.'); return true; }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  NAVIGATION
  // ════════════════════════════════════════════════════════════════════════
  var TITLES = { scan: 'Scan', products: 'Products', log: 'Log', profile: 'Profile' };

  function showScreen(name) {
    ['scan', 'products', 'log', 'profile'].forEach(function (s) {
      var el = $('screen-' + s);
      if (el) el.classList.toggle('active', s === name);
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.screen === name);
    });
    $('appbar-title').textContent = TITLES[name] || '';
    // camera only runs on the Scan screen (saves battery / frees the camera)
    if (name === 'scan') startScanner(); else stopScanner();
    if (name === 'products' && !allProducts.length) loadProducts();
    if (name === 'log') renderLog();
  }

  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { showScreen(b.dataset.screen); });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  AUTH
  // ════════════════════════════════════════════════════════════════════════
  function enterApp() {
    $('screen-login').classList.remove('active');
    $('app').hidden = false;
    $('greet-name').textContent = (user && user.username) || 'there';
    $('profile-username').textContent = (user && user.username) || '—';
    $('profile-email').textContent = (user && user.email) || '—';
    showScreen('scan');
    renderLog();
    // preload the whole catalogue once → instant local scans + ready Products tab,
    // and it doubles as an immediate session-validity check on open.
    loadProducts();
  }

  // show exactly one of the full-screen auth screens (enroll | blocked | login)
  function showAuthScreen(which) {
    stopScanner();
    $('app').hidden = true;
    ['enroll', 'blocked', 'login'].forEach(function (s) {
      $('screen-' + s).classList.toggle('active', s === which);
    });
  }
  function showLogin() { showAuthScreen('login'); }

  function showBlocked(until) {
    var msg = 'This device has been blocked. Please contact your administrator.';
    if (until && Number(until) > Date.now()) {
      var mins = Math.ceil((Number(until) - Date.now()) / 60000);
      msg = 'Too many wrong attempts. This device is blocked for about ' +
            mins + ' minute' + (mins === 1 ? '' : 's') + '.';
    }
    $('blocked-msg').textContent = msg;
    showAuthScreen('blocked');
  }

  // Decide which gate to show when we have no valid session: a blocked device sees
  // the block screen, an un-enrolled device must enter its one-time code, otherwise
  // (enrolled, or the gate is disabled server-side) go straight to login.
  function routeUnauthed(msg) {
    if (msg) toast(msg, true);
    api('deviceStatus', {}).then(function (res) {
      var st = res && res.state;
      if (st === 'blocked') showBlocked(res.until);
      else if (st === 'unenrolled') showAuthScreen('enroll');
      else showLogin(); // 'enrolled', gate off, or network error → let them try to log in
    });
  }

  $('enroll-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('enroll-code').value.trim();
    var errEl = $('enroll-error'); errEl.hidden = true;
    if (!code) { showErr(errEl, 'Enter the access code.'); return; }
    var btn = $('enroll-btn'); btn.disabled = true; btn.textContent = 'Activating…';
    api('enrollDevice', { code: code }).then(function (res) {
      btn.disabled = false; btn.textContent = 'Activate';
      if (res && res.ok) { $('enroll-code').value = ''; showLogin(); toast('Device activated ✓'); return; }
      if (res && res.state === 'blocked') { showBlocked(res.until); return; }
      var left = (res && typeof res.attemptsLeft === 'number') ? res.attemptsLeft : null;
      var msg = ({
        bad_code: 'Incorrect code' + (left != null ? ' — ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left.' : '.'),
        network: 'Network error — check your connection.',
        bad_response: 'Server error — please try again.'
      })[res && res.reason] || 'Could not activate. Please try again.';
      showErr(errEl, msg);
    });
  });

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = $('login-id').value.trim();
    var pw = $('login-pw').value;
    var errEl = $('login-error');
    errEl.hidden = true;
    if (!id || !pw) { showErr(errEl, 'Enter your email/username and password.'); return; }

    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Logging in…';
    api('login', { identifier: id, password: pw }).then(function (res) {
      btn.disabled = false; btn.textContent = 'Log in';
      if (res.ok) {
        token = res.sessionToken;
        user = res.user;
        localStorage.setItem(KEYS.token, token);
        localStorage.setItem(KEYS.user, JSON.stringify(user));
        $('login-pw').value = '';
        enterApp();
        return;
      }
      // device isn't activated on this phone → send them to the enrollment gate
      if (res.reason === 'device_not_enrolled') {
        showAuthScreen('enroll');
        showErr($('enroll-error'), 'Activate this device first with your access code.');
        return;
      }
      var msg = ({
        bad_credentials: 'Incorrect email/username or password.',
        inactive: 'Your account is not active — contact admin.',
        locked: 'Too many attempts. Try again in ~10 minutes.',
        no_config: 'App is not configured yet (missing server URL).',
        network: 'Network error — check your connection.',
        bad_response: 'Server error — please try again.'
      })[res.reason] || 'Could not log in. Please try again.';
      showErr(errEl, msg);
    });
  });

  function doLogout(msg) {
    token = null; user = null;
    localStorage.removeItem(KEYS.token);
    localStorage.removeItem(KEYS.user);
    // re-check device state so a revoked/blocked device lands on the right gate,
    // not the login form. routeUnauthed shows the toast for us.
    routeUnauthed(msg);
  }
  $('logout-btn').addEventListener('click', function () { doLogout(); });

  // ════════════════════════════════════════════════════════════════════════
  //  SCANNER (html5-qrcode, continuous multi-scan)
  // ════════════════════════════════════════════════════════════════════════
  var qr = null, scanning = false, busy = false;
  var lastCode = '', lastAt = 0;

  function supportedFormats() {
    // EAN-13 first, then CODE128, EAN-8, UPC-A, QR (§2)
    var F = window.Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    return [F.EAN_13, F.CODE_128, F.EAN_8, F.UPC_A, F.QR_CODE];
  }

  var starting = false;
  var videoTrack = null;
  function startScanner() {
    if (scanning || starting) return;
    if (!window.Html5Qrcode) { toast('Scanner failed to load.', true); return; }
    starting = true;
    qr = qr || new Html5Qrcode('reader', {
      formatsToSupport: supportedFormats(),
      // use the phone's built-in barcode detector when available (much faster on Android)
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false
    });
    var cfg = {
      fps: 16,
      // Wide, short box — retail barcodes are far wider than tall, so a near-square
      // box wastes resolution and makes them harder to line up.
      qrbox: function (w, h) {
        return { width: Math.floor(w * 0.88),
                 height: Math.floor(Math.min(h * 0.5, w * 0.45)) };
      },
      disableFlip: true
    };
    // Try richer settings first, then fall back, so the camera ALWAYS opens on a
    // device that can't satisfy the high-res request (some phones — iOS especially —
    // reject the whole getUserMedia call otherwise). NOTE: no focusMode here — it's
    // re-applied after the stream starts in applyFocusTweaks(), where a rejection is
    // harmless. High res matters because at ~640x480 an EAN-13's bars are too few
    // pixels to decode.
    var attempts = [
      { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      { facingMode: { ideal: 'environment' } },
      { facingMode: 'environment' }
    ];
    (function tryStart(i) {
      var p;
      try { p = qr.start(attempts[i], cfg, onScan, function () { /* per-frame decode misses: ignore */ }); }
      catch (e) { p = Promise.reject(e); }
      p.then(function () {
        scanning = true; starting = false;
        $('viewfinder').classList.add('live');
        $('scan-toggle').textContent = 'Stop camera';
        applyFocusTweaks();
      }).catch(function (err) {
        console.warn('camera start failed (attempt ' + i + ')', err);
        if (i + 1 < attempts.length) { tryStart(i + 1); return; }
        starting = false;
        $('tap-hint').textContent = 'Tap to start the camera';
        toast('Cannot open camera — allow camera access in your browser settings.', true);
      });
    })(0);
  }

  // Grab the live video track and (re-)assert continuous autofocus. Some Android
  // browsers ignore focusMode in the initial getUserMedia but honour it via a
  // later applyConstraints(), so we do it again once the stream is running.
  function applyFocusTweaks() {
    try {
      var video = document.querySelector('#reader video');
      var stream = video && video.srcObject;
      videoTrack = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
      if (!videoTrack || !videoTrack.applyConstraints) return;
      var caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
      setupZoom(caps);
    } catch (e) {}
  }

  // Optical/digital zoom slider — only shown when the camera reports a zoom range.
  // Lets staff read small or far-away barcodes without walking up to them.
  function setupZoom(caps) {
    var wrap = $('zoom-wrap'), range = $('zoom-range');
    if (!wrap || !range) return;
    if (!caps || !caps.zoom || !videoTrack || !(caps.zoom.max > caps.zoom.min)) { wrap.hidden = true; return; }
    range.min = caps.zoom.min; range.max = caps.zoom.max; range.step = caps.zoom.step || 0.1;
    var cur = (videoTrack.getSettings && videoTrack.getSettings().zoom) || caps.zoom.min;
    range.value = cur;
    wrap.hidden = false;
    range.oninput = function () {
      try { videoTrack.applyConstraints({ advanced: [{ zoom: Number(range.value) }] }).catch(function () {}); } catch (e) {}
    };
  }

  // Tap the viewfinder while scanning to force a refocus (single-shot → continuous),
  // for the occasional barcode the lens won't lock onto on its own.
  function refocus() {
    if (!videoTrack || !videoTrack.applyConstraints) return;
    try {
      var caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
      var modes = (caps && caps.focusMode) || [];
      if (modes.indexOf('single-shot') !== -1 && modes.indexOf('continuous') !== -1) {
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] })
          .then(function () { return videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); })
          .catch(function () {});
      } else if (modes.indexOf('continuous') !== -1) {
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
      flashToast('Refocusing…');
    } catch (e) {}
  }

  function stopScanner() {
    if (qr && scanning) {
      try { qr.stop().then(function () { try { qr.clear(); } catch (e) {} }).catch(function () {}); } catch (e) {}
    }
    scanning = false;
    videoTrack = null;
    var vf = $('viewfinder'); if (vf) vf.classList.remove('live');
    var zw = $('zoom-wrap'); if (zw) zw.hidden = true;
    var t = $('scan-toggle'); if (t) t.textContent = 'Start camera';
  }

  $('scan-toggle').addEventListener('click', function () {
    if (scanning) stopScanner(); else startScanner();
  });
  // tapping the viewfinder (re)starts the camera if stopped, or forces a refocus
  // while running — handy for a barcode the lens won't lock onto.
  $('viewfinder').addEventListener('click', function () { if (!scanning) startScanner(); else refocus(); });

  function onScan(decoded) {
    var now = Date.now();
    decoded = String(decoded || '').trim();
    if (busy || !decoded) return;
    if (decoded === lastCode && now - lastAt < 2500) return;   // ignore immediate repeats
    if (now - lastAt < CFG.SCAN_COOLDOWN_MS) return;            // global cooldown
    lastCode = decoded; lastAt = now; busy = true;
    if (navigator.vibrate) { try { navigator.vibrate(55); } catch (e) {} }

    // 1) instant local hit from the preloaded catalogue — no network round-trip
    var local = barcodeIndex[decoded];
    if (local) {
      acceptScan(local, decoded);
      setTimeout(function () { busy = false; }, CFG.SCAN_COOLDOWN_MS);
      return;
    }

    // 2) not cached → ask the server (covers items added since load)
    flashToast('Looking up ' + decoded + '…');
    api('lookup', { barcode: decoded }).then(function (res) {
      setTimeout(function () { busy = false; }, CFG.SCAN_COOLDOWN_MS);
      if (handleUnauthorized(res)) return;
      if (res && res.found) {
        var p = normalizeProduct(res);
        if (p.barcode) barcodeIndex[p.barcode] = p; // cache for next time
        acceptScan(p, decoded);
      } else {
        flashToast('✗ Not found: ' + decoded);
        openNotFound(decoded);
      }
    });
  }

  function acceptScan(p, decoded) {
    var entry = {
      sku: p.sku, name: p.name, barcode: p.barcode || decoded,
      image: p.image, price: p.price, at: Date.now()
    };
    sessionScans.unshift(entry);
    renderSession();
    pushLog(entry);
    flashToast('✓ ' + p.name);
  }

  function flashToast(msg) {
    var t = $('scan-toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(function () { t.hidden = true; }, 1600);
  }

  // ── manual barcode entry (camera-can't-read fallback) ─────────────────────
  // Same data path as a camera scan: instant local cache first, then the server,
  // then accept (adds to the session) or show the not-found sheet.
  function manualLookup(code) {
    code = String(code || '').replace(/\D/g, '');
    if (!code) return;
    var input = $('manual-code');
    var local = barcodeIndex[code];
    if (local) { acceptScan(local, code); input.value = ''; return; }
    flashToast('Looking up ' + code + '…');
    api('lookup', { barcode: code }).then(function (res) {
      if (handleUnauthorized(res)) return;
      if (res && res.found) {
        var p = normalizeProduct(res);
        if (p.barcode) barcodeIndex[p.barcode] = p;
        acceptScan(p, code);
        input.value = '';
      } else {
        flashToast('✗ Not found: ' + code);
        openNotFound(code);   // keep the typed code so they can correct it
      }
    });
  }
  var manualTimer = null;
  $('manual-form').addEventListener('submit', function (e) {
    e.preventDefault(); clearTimeout(manualTimer); manualLookup($('manual-code').value);
  });
  $('manual-code').addEventListener('input', function () {
    var el = $('manual-code');
    var v = el.value.replace(/\D/g, '');
    if (v !== el.value) el.value = v;        // digits only
    clearTimeout(manualTimer);
    // auto-fire once a complete retail barcode is typed (EAN-8 / UPC-A / EAN-13)
    if (v.length === 8 || v.length === 12 || v.length === 13) {
      manualTimer = setTimeout(function () { manualLookup(v); }, 150);
    }
  });

  // ── session list ────────────────────────────────────────────────────────
  function renderSession() {
    $('session-count').textContent = String(sessionScans.length);
    var box = $('session-list');
    if (!sessionScans.length) {
      box.innerHTML = '';
      box.appendChild(emptyEl('Scan a barcode to begin. Scans stack up here.'));
      return;
    }
    box.innerHTML = '';
    sessionScans.forEach(function (e) { box.appendChild(rowEl(e, true)); });
  }
  $('session-clear').addEventListener('click', function () { sessionScans = []; renderSession(); });

  // ════════════════════════════════════════════════════════════════════════
  //  PERSISTENT LOG
  // ════════════════════════════════════════════════════════════════════════
  function pushLog(entry) {
    scanLog.unshift({ name: entry.name, sku: entry.sku, barcode: entry.barcode, image: entry.image, at: entry.at });
    if (scanLog.length > 500) scanLog = scanLog.slice(0, 500);
    try { localStorage.setItem(KEYS.log, JSON.stringify(scanLog)); } catch (e) {}
  }
  function renderLog() {
    var box = $('log-list');
    box.innerHTML = '';
    if (!scanLog.length) { box.appendChild(emptyEl('No scans yet.')); return; }
    scanLog.forEach(function (e) { box.appendChild(rowEl(e, false)); });
  }
  $('log-clear').addEventListener('click', function () {
    scanLog = []; try { localStorage.removeItem(KEYS.log); } catch (e) {}
    renderLog();
  });

  // a row used by both session list and log
  function rowEl(e, showPrice) {
    var row = document.createElement('div');
    row.className = 'row';
    var img = document.createElement('img');
    img.className = 'row-thumb'; img.loading = 'lazy'; img.alt = '';
    if (e.image) img.src = e.image;
    var main = document.createElement('div'); main.className = 'row-main';
    var nm = document.createElement('div'); nm.className = 'row-name'; nm.textContent = e.name || '(no name)';
    var sub = document.createElement('div'); sub.className = 'row-sub';
    sub.textContent = (e.sku ? 'SKU ' + e.sku : '') + (e.barcode ? '  ·  ' + e.barcode : '');
    main.appendChild(nm); main.appendChild(sub);
    var right = document.createElement('div'); right.className = 'row-right';
    if (showPrice && e.price != null) {
      var pr = document.createElement('div'); pr.className = 'row-price'; pr.textContent = 'RM ' + fmt(e.price);
      right.appendChild(pr);
    }
    var tm = document.createElement('div'); tm.className = 'row-time'; tm.textContent = timeStr(e.at);
    right.appendChild(tm);
    row.appendChild(img); row.appendChild(main); row.appendChild(right);
    // tapping opens the full product card (look up fresh by barcode/sku)
    row.addEventListener('click', function () { openProductByEntry(e); });
    return row;
  }

  function openProductByEntry(e) {
    // prefer the instant local cache; only hit the server if it's not there
    if (e.barcode && barcodeIndex[e.barcode]) { openProduct(barcodeIndex[e.barcode]); return; }
    if (e.barcode) {
      api('lookup', { barcode: e.barcode }).then(function (res) {
        if (handleUnauthorized(res)) return;
        if (res && res.found) openProduct(normalizeProduct(res));
        else openProduct({ sku: e.sku, name: e.name, barcode: e.barcode, image: e.image, price: e.price });
      });
    } else {
      openProduct({ sku: e.sku, name: e.name, barcode: e.barcode, image: e.image, price: e.price });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PRODUCTS + SEARCH + CHIPS
  // ════════════════════════════════════════════════════════════════════════
  var activeCat = 'All';

  function loadProducts() {
    var box = $('products-list');
    box.innerHTML = ''; box.appendChild(emptyEl('Loading products…'));
    api('allProducts', {}).then(function (res) {
      if (handleUnauthorized(res)) return;
      var list = (res && res.products) || (Array.isArray(res) ? res : []);
      allProducts = list.map(normalizeProduct);
      productsLoaded = true;
      // build the instant-lookup index (barcode -> product)
      barcodeIndex = {};
      allProducts.forEach(function (p) { if (p.barcode) barcodeIndex[String(p.barcode).trim()] = p; });
      buildChips();
      renderProducts(allProducts);
    });
  }

  function buildChips() {
    var cats = ['All'];
    allProducts.forEach(function (p) { if (p.category && cats.indexOf(p.category) < 0) cats.push(p.category); });
    var box = $('chips'); box.innerHTML = '';
    cats.forEach(function (c) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (c === activeCat ? ' active' : '');
      chip.textContent = c;
      chip.addEventListener('click', function () {
        activeCat = c;
        document.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('active', x === chip); });
        applyFilter();
      });
      box.appendChild(chip);
    });
  }

  function renderProducts(list) {
    var box = $('products-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyEl('No products found.')); return; }
    list.forEach(function (p) {
      var card = document.createElement('button');
      card.className = 'pcard';
      var img = document.createElement('img');
      img.className = 'pcard-img'; img.loading = 'lazy'; img.alt = '';
      if (p.image) img.src = p.image;
      var body = document.createElement('div'); body.className = 'pcard-body';
      var nm = document.createElement('div'); nm.className = 'pcard-name'; nm.textContent = p.name || '(no name)';
      var sku = document.createElement('div'); sku.className = 'pcard-sku'; sku.textContent = p.sku ? 'SKU ' + p.sku : '';
      body.appendChild(nm); body.appendChild(sku);
      if (p.price != null) {
        var pr = document.createElement('div'); pr.className = 'pcard-price'; pr.textContent = 'RM ' + fmt(p.price);
        body.appendChild(pr);
      }
      card.appendChild(img); card.appendChild(body);
      card.addEventListener('click', function () { openProduct(p); });
      box.appendChild(card);
    });
  }

  function applyFilter() {
    var q = $('search-input').value.trim().toLowerCase();
    var list = allProducts.filter(function (p) {
      if (activeCat !== 'All' && p.category !== activeCat) return false;
      if (!q) return true;
      return (p.name || '').toLowerCase().indexOf(q) >= 0 || (p.sku || '').toLowerCase().indexOf(q) >= 0;
    });
    renderProducts(list);
  }

  var searchTimer = null;
  $('search-input').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = $('search-input').value.trim();
    // local filter is instant; for long queries also ask the server (covers items not yet cached)
    searchTimer = setTimeout(function () {
      if (q.length >= 2 && allProducts.length) { applyFilter(); }
      else applyFilter();
    }, 120);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  PRODUCT CARD (sheet) — image, name, sku, price, discount, barcode
  // ════════════════════════════════════════════════════════════════════════
  var currentProduct = null, discount = 0;

  function openProduct(p) {
    currentProduct = p; discount = 0;
    $('pc-img').src = p.image || '';
    $('pc-img').alt = p.name || '';
    $('pc-name').textContent = p.name || '(no name)';
    $('pc-sku').textContent = p.sku ? 'SKU ' + p.sku : 'SKU —';
    $('pc-price').textContent = p.price != null ? 'RM ' + fmt(p.price) : 'RM —';
    discount = 0; $('disc-val').value = '0'; updateFinal();
    renderBarcodePreview(p.barcode);
    openSheet('sheet-product');
  }

  // any whole percent 0–100 (staff pick the exact figure: 15, 18, 20, …)
  function clampPct(v) { v = Math.round(Number(v)); return isFinite(v) ? Math.min(100, Math.max(0, v)) : 0; }
  function updateFinal() {
    var p = currentProduct;
    $('pc-final').textContent = (p && p.price != null)
      ? 'RM ' + fmt(p.price * (1 - discount / 100)) : 'RM —';
  }
  var discInput = $('disc-val');
  // live typing: use the value for the math but don't rewrite the field (keeps the caret)
  discInput.addEventListener('input', function () {
    discount = discInput.value === '' ? 0 : clampPct(discInput.value);
    updateFinal();
  });
  discInput.addEventListener('blur', function () {
    discount = clampPct(discInput.value === '' ? 0 : discInput.value);
    discInput.value = String(discount); updateFinal();
  });
  function stepDiscount(delta) { discount = clampPct(discount + delta); discInput.value = String(discount); updateFinal(); }
  $('disc-minus').addEventListener('click', function () { stepDiscount(-1); });
  $('disc-plus').addEventListener('click', function () { stepDiscount(1); });

  function renderBarcodePreview(code) {
    var svg = $('pc-barcode');
    svg.innerHTML = '';
    if (!code || !window.JsBarcode) { svg.style.display = 'none'; return; }
    svg.style.display = '';
    var done = false;
    if (/^\d{13}$/.test(code)) {
      try { JsBarcode(svg, code, { format: 'EAN13', displayValue: true, margin: 8, height: 60 }); done = true; } catch (e) {}
    }
    if (!done) {
      try { JsBarcode(svg, code, { format: 'CODE128', displayValue: true, margin: 8, height: 60 }); }
      catch (e) { svg.style.display = 'none'; }
    }
  }

  $('pc-edit').addEventListener('click', function () {
    if (currentProduct) openEdit(currentProduct);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  NOT FOUND
  // ════════════════════════════════════════════════════════════════════════
  function openNotFound(code) {
    $('nf-code').textContent = code;
    $('sheet-notfound').dataset.code = code;
    openSheet('sheet-notfound');
  }
  $('nf-add').addEventListener('click', function () {
    var code = $('sheet-notfound').dataset.code || '';
    closeSheet('sheet-notfound');
    openEdit({ sku: '', name: '', barcode: code }, { field: 'Other', current: code, reason: 'Please add this scanned product.' });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  EDIT REQUEST
  // ════════════════════════════════════════════════════════════════════════
  function openEdit(p, pre) {
    pre = pre || {};
    $('er-sku').value = p.sku || '';
    $('er-name').value = p.name || '';
    $('er-field').value = pre.field || 'Name';
    $('er-current').value = pre.current != null ? pre.current : '';
    $('er-new').value = '';
    $('er-reason').value = pre.reason || '';
    $('er-error').hidden = true;
    closeSheet('sheet-product');
    openSheet('sheet-edit');
  }

  $('edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var errEl = $('er-error'); errEl.hidden = true;
    var reason = $('er-reason').value.trim();
    if (reason.length > 500) { showErr(errEl, 'Reason is too long (max 500 characters).'); return; }
    var data = {
      sku: $('er-sku').value.trim(),
      productName: $('er-name').value.trim(),
      field: $('er-field').value,
      currentValue: $('er-current').value.trim(),
      newValue: $('er-new').value.trim(),
      reason: reason
    };
    var btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Submitting…';
    api('editRequest', data).then(function (res) {
      btn.disabled = false; btn.textContent = 'Submit request';
      if (handleUnauthorized(res)) return;
      if (res && res.ok) { closeSheet('sheet-edit'); toast('Request submitted ✓'); }
      else showErr(errEl, (res && res.msg) || 'Could not submit. Try again.');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  PROFILE — change username / password
  // ════════════════════════════════════════════════════════════════════════
  var credMode = null; // 'username' | 'password'

  document.querySelectorAll('[data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      credMode = b.dataset.act === 'change-username' ? 'username' : 'password';
      $('cred-title').textContent = credMode === 'username' ? 'Change username' : 'Change password';
      $('cred-new-label').textContent = credMode === 'username' ? 'New username' : 'New password';
      $('cred-new').type = credMode === 'username' ? 'text' : 'password';
      $('cred-new').value = '';
      $('cred-current').value = '';
      $('cred-error').hidden = true;
      openSheet('sheet-cred');
    });
  });

  $('cred-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var errEl = $('cred-error'); errEl.hidden = true;
    var current = $('cred-current').value;
    var next = $('cred-new').value;
    if (!current) { showErr(errEl, 'Enter your current password.'); return; }

    if (credMode === 'username') {
      var u = next.trim();
      if (!RE_USER.test(u)) { showErr(errEl, 'Username must be 2–30 chars: letters, digits, space . _ -'); return; }
    } else {
      // password: any strength accepted (§4.2) — only block empty / overly long
      if (!next) { showErr(errEl, 'Enter a new password.'); return; }
      if (next.length > 256) { showErr(errEl, 'Password is too long.'); return; }
    }

    var btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Saving…';
    var action = credMode === 'username' ? 'changeUsername' : 'changePassword';
    var params = credMode === 'username'
      ? { currentPassword: current, newUsername: next.trim() }
      : { currentPassword: current, newPassword: next };

    api(action, params).then(function (res) {
      btn.disabled = false; btn.textContent = 'Save';
      if (handleUnauthorized(res)) return;
      if (res && res.ok) {
        if (credMode === 'username') {
          user.username = res.username;
          localStorage.setItem(KEYS.user, JSON.stringify(user));
          $('profile-username').textContent = user.username;
          $('greet-name').textContent = user.username;
        }
        closeSheet('sheet-cred');
        toast('Saved ✓');
      } else {
        var msg = ({
          bad_password: 'Current password is incorrect.',
          taken: 'That username is already taken.',
          invalid: 'That username is not valid.'
        })[res.reason] || 'Could not save. Try again.';
        showErr(errEl, msg);
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  SHEETS / TOAST / HELPERS
  // ════════════════════════════════════════════════════════════════════════
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }
  document.querySelectorAll('[data-close]').forEach(function (el) {
    el.addEventListener('click', function () { el.closest('.sheet').hidden = true; });
  });

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    t.classList.toggle('err', !!isErr);
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2400);
  }
  function showErr(el, msg) { el.textContent = msg; el.hidden = false; }

  function normalizeProduct(p) {
    // tolerate server returning `image` or `imageUrl`
    return {
      sku: p.sku || '',
      name: p.name || '',
      barcode: p.barcode || '',
      image: p.image || p.imageUrl || '',
      price: (p.price === 0 || p.price) ? Number(p.price) : null,
      category: p.category || p.cat || ''
    };
  }
  function fmt(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }
  function timeStr(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function emptyEl(txt) { var p = document.createElement('p'); p.className = 'empty'; p.textContent = txt; return p; }
  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  // ════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════════════════
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  if (token && user) enterApp(); else routeUnauthed();

})();
