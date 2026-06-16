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
    if (res.reason === 'inactive') { doLogout(t('acc_deactivated')); return true; }
    if (res.reason === 'device_revoked') { doLogout(t('device_unauth')); return true; }
    if (res.reason === 'unauthorized') { doLogout(t('session_expired')); return true; }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  NAVIGATION
  // ════════════════════════════════════════════════════════════════════════
  var activeScreen = 'scan';
  var greetName = 'there';
  function renderGreeting() { var g = $('greeting'); if (g) g.textContent = t('greeting', { name: greetName }); }

  // Re-render everything language-dependent when the user flips EN/AR. Static text is
  // handled by i18n.js; here we redo the JS-rendered bits.
  window.addEventListener('langchange', function () {
    if (!$('app').hidden) {
      $('appbar-title').textContent = t('nav_' + activeScreen);
      renderGreeting();
      var st = $('scan-toggle'); if (st) st.textContent = t(scanning ? 'stop_cam' : 'start_cam');
      if (!scanning) { var th = $('tap-hint'); if (th) th.textContent = t('tap_start'); }
      try { renderSession(); } catch (e) {}
      try { renderLog(); } catch (e) {}
      if (allProducts.length) { try { applyFilter(); } catch (e) {} }
    }
  });

  function showScreen(name) {
    ['scan', 'products', 'log', 'profile'].forEach(function (s) {
      var el = $('screen-' + s);
      if (el) el.classList.toggle('active', s === name);
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.screen === name);
    });
    activeScreen = name;
    $('appbar-title').textContent = t('nav_' + name);
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
    greetName = (user && user.username) || 'there'; renderGreeting();
    $('profile-username').textContent = (user && user.username) || '—';
    $('profile-email').textContent = (user && user.email) || '—';
    showScreen('scan');
    renderLog();
    // preload the whole catalogue once → instant local scans + ready Products tab,
    // and it doubles as an immediate session-validity check on open.
    loadProducts();
    startHeartbeat();
  }

  // ── session heartbeat ─────────────────────────────────────────────────────
  // Scanning a cached product never hits the server, so without this a staffer
  // whose "Active" was just unchecked could keep working. The heartbeat re-checks
  // the session every 30s (and whenever the app is refocused) → the server returns
  // inactive/device_revoked/unauthorized and we log them out promptly.
  var heartbeat = null;
  function checkSession() {
    if (!token) return;
    api('ping', {}).then(function (res) {
      if (res && res.ok) return;
      handleUnauthorized(res); // logs out on inactive / device_revoked / unauthorized; ignores network errors
    });
  }
  function startHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(checkSession, 30000);
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkSession();
  });

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
    var btn = $('enroll-btn'); btn.disabled = true; btn.textContent = t('activating');
    api('enrollDevice', { code: code }).then(function (res) {
      btn.disabled = false; btn.textContent = t('activate_btn');
      if (res && res.ok) { $('enroll-code').value = ''; showLogin(); toast(t('device_activated')); return; }
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

    var btn = $('login-btn'); btn.disabled = true; btn.textContent = t('logging_in');
    api('login', { identifier: id, password: pw }).then(function (res) {
      btn.disabled = false; btn.textContent = t('login_btn');
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
    stopHeartbeat();
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
  // iPad Safari reports itself as MacIntel, hence the maxTouchPoints check.
  var IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function supportedFormats() {
    // EAN-13 first, then CODE128, EAN-8, UPC-A, QR (§2)
    var F = window.Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    return [F.EAN_13, F.CODE_128, F.EAN_8, F.UPC_A, F.QR_CODE];
  }

  var starting = false;
  var videoTrack = null;
  var pickedCameraId = null;   // cached main-lens deviceId, resolved once per load
  var detectTimer = null;      // native-scanner BarcodeDetector loop handle
  var nativeStream = null;     // native-scanner MediaStream (so we can stop its tracks)
  var usingNative = false;     // true while the native getUserMedia+BarcodeDetector path is live

  // Pick the MAIN rear lens. Android phones expose several physical back cameras
  // (main / ultra-wide / telephoto / macro / depth). facingMode:'environment' lets
  // Chrome choose, and it frequently picks the ULTRA-WIDE — which cannot focus on a
  // barcode held close, so the image stays blurry and nothing ever decodes. We pick
  // the plain main lens by deviceId instead. Labels are only populated AFTER camera
  // permission is granted, so if they're empty we briefly open a stream to unlock
  // them, then enumerate. Returns a deviceId string, or null to fall back to
  // facingMode (iOS has a single logical back camera, so this is mostly a no-op there).
  function resolveCamera() {
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.resolve(null);

    function chooseFrom(devices) {
      var vids = devices.filter(function (d) { return d.kind === 'videoinput' && d.label; });
      if (!vids.length) return null;
      var back = vids.filter(function (d) { return /back|rear|environment|arrière|trasera|背面/i.test(d.label); });
      var pool = back.length ? back : vids;
      // Drop only the lenses that are useless for close barcodes: ULTRA-wide,
      // telephoto, and the fixed-focus depth/macro/mono sensors. We deliberately do
      // NOT drop plain "wide" — on most phones the MAIN camera is the wide one, and
      // excluding it was picking a fixed-focus auxiliary sensor (the blur in ErrorV2).
      var special = /ultra|tele|zoom|depth|macro|mono|infrared|\bir\b|front/i;
      var main = pool.filter(function (d) { return !special.test(d.label); });
      var chosen = main[0] || pool[0];
      return chosen ? chosen.deviceId : null;
    }

    return md.enumerateDevices().then(function (devices) {
      var id = chooseFrom(devices);
      if (id) return id;
      // Labels empty → no permission yet. Open a throwaway stream to unlock labels.
      return md.getUserMedia({ video: { facingMode: 'environment' } }).then(function (s) {
        try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        return md.enumerateDevices().then(chooseFrom);
      }).catch(function () { return null; });
    }).catch(function () { return null; });
  }

  function startScanner() {
    if (scanning || starting) return;
    starting = true;

    // BEST native path: the ML Kit barcode scanner (real camera + hardware autofocus +
    // bundled on-device model, no Google Play Services). The WebView camera on some
    // phones (Huawei) won't autofocus, so the in-page detector can't read; ML Kit does.
    if (nativeScanSupported()) { startMlkitScan(); return; }

    // Fallback native path (APK without the ML Kit plugin): raw getUserMedia + the
    // WebView's built-in BarcodeDetector. Browsers/PWA (incl. iOS) keep the html5-qrcode
    // path below.
    if (window.Capacitor && ('BarcodeDetector' in window)) { startNativeScanner(); return; }

    if (!window.Html5Qrcode) { toast(t('scanner_failed'), true); starting = false; return; }
    function makeScanner() {
      return new Html5Qrcode('reader', {
        formatsToSupport: supportedFormats(),
        // use the phone's built-in barcode detector when available (much faster on Android)
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });
    }
    var cfg = {
      // More decode attempts per second = quicker reads on both platforms. The native
      // detector (Android) and the WASM decoder (iPhone) both comfortably keep up at 24.
      fps: 24,
      // Keep a qrbox so html5-qrcode crops the decode to the centre (smaller image =
      // faster reads, esp. on the WASM path). Sized to match our .reticle. Its
      // bracket overlay is hidden in CSS (#qr-shaded-region) so only the reticle
      // shows — the two overlapping frames were the UI bug.
      qrbox: function (w, h) {
        var bw = Math.floor(Math.min(w * 0.8, w));
        return { width: bw, height: Math.floor(Math.min(h * 0.45, bw * 0.62)) };
      },
      // No aspectRatio: 1.0 — forcing a square stream makes the camera crop the
      // sensor (a zoomed, lower-res image). Let it deliver its native (wider) frame;
      // we size the viewfinder to match the real frame in fitViewfinder() so the
      // preview shows the full field of view, exactly like the native camera app.
      disableFlip: true
    };

    // Tear down a stuck/old scanner and hand back a guaranteed-clean instance. The
    // Android WebView keeps the page alive across app reopens, so a previous failed/
    // half-open start stays SCANNING/PAUSED or locked mid-transition; reusing it makes
    // start() throw "Cannot transition to a new state". A FRESH Html5Qrcode is always
    // NOT_STARTED, so we rebuild whenever the current one isn't cleanly idle.
    // getState(): 1=NOT_STARTED, 2=SCANNING, 3=PAUSED.
    function ensureCleanScanner() {
      if (!qr) { qr = makeScanner(); return Promise.resolve(); }
      var st;
      try { st = qr.getState ? qr.getState() : 1; } catch (e) { st = 0; }
      if (st === 1) return Promise.resolve();          // already idle → reuse (keeps first-tap synchronous)
      var old = qr; qr = null;                          // discard the stuck one, build fresh
      return Promise.resolve()
        .then(function () { return old.stop(); }).catch(function () {})
        .then(function () { try { old.clear(); } catch (e) {} })
        .catch(function () {})
        .then(function () { qr = makeScanner(); });
    }

    // Start with one delayed retry for a momentarily "busy" camera (NotReadable/Abort)
    // and a fallback from an exact deviceId to a loose facingMode request. If the library
    // itself errors with a state/transition message, rebuild a fresh instance and retry.
    function tryStart(source) {
      return qr.start(source, cfg, onScan, function () { /* per-frame misses: ignore */ })
        .catch(function (err) {
          var n = err && err.name;
          var msg = ((err && (err.message || err.name)) || err) + '';
          if (/transition|already|not in (the )?correct|state/i.test(msg) && !n) {
            var old = qr; qr = null;
            return Promise.resolve()
              .then(function () { return old.stop(); }).catch(function () {})
              .then(function () { try { old.clear(); } catch (e) {} })
              .then(function () { qr = makeScanner(); return new Promise(function (r) { setTimeout(r, 300); }); })
              .then(function () { return qr.start(source, cfg, onScan, function () {}); });
          }
          if (source.deviceId && (n === 'OverconstrainedError' || n === 'NotFoundError' || n === 'NotReadableError')) {
            pickedCameraId = null;
            return new Promise(function (r) { setTimeout(r, 500); })
              .then(function () { return qr.start({ facingMode: 'environment', advanced: [{ focusMode: 'continuous' }] }, cfg, onScan, function () {}); });
          }
          if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') {
            return new Promise(function (r) { setTimeout(r, 700); }).then(function () { return qr.start(source, cfg, onScan, function () {}); });
          }
          throw err;
        });
    }

    // CRITICAL — open the camera DIRECTLY inside this tap, on every platform. Calling
    // enumerateDevices()/getUserMedia() first (to pick the "main lens") consumes the
    // tap's transient user-activation; Chrome (Android) and Safari (iOS) then reject the
    // real open with NotAllowedError when the permission is still in the "ask" state —
    // which looks exactly like a denied permission even though the user never denied it.
    // So: open first with a plain facingMode request, resolve the better lens LATER.
    //
    // On a 2nd+ start in the same session the permission is already granted, so the
    // cached main-lens deviceId (Android) is safe to use straight away.
    var source = (!IS_IOS && pickedCameraId)
      ? { deviceId: { exact: pickedCameraId } }
      : { facingMode: 'environment' };
    // focusMode goes in `advanced` (best-effort, never causes the request to be
    // rejected). Resolution is applied AFTER the stream is live, where it can't block.
    source.advanced = [{ focusMode: 'continuous' }];
    ensureCleanScanner()
      .then(function () { return tryStart(source); })
      .then(function () {
        scanning = true; starting = false;
        $('viewfinder').classList.add('live');
        $('scan-toggle').textContent = t('stop_cam');
        applyFocusTweaks();
        // Permission is granted and a stream is live → now it's safe to find the best
        // rear lens (labels are populated, so resolveCamera won't open a throwaway
        // stream) and cache it for the NEXT start. We do NOT restart the current stream,
        // so there's no flicker; the optimal lens just kicks in next time (Android only).
        if (!IS_IOS && !pickedCameraId) {
          resolveCamera().then(function (id) { if (id) pickedCameraId = id; }).catch(function () {});
        }
      })
      .catch(function (err) {
        starting = false;
        $('tap-hint').textContent = t('tap_start');
        toast(cameraErrText(err), true);
        console.warn('camera start failed', err);
      });
  }

  // Native-app scanner: own <video> + the WebView's BarcodeDetector. No html5-qrcode,
  // so none of its WebView rendering/state problems apply. Reuses the same videoTrack
  // helpers (focus, zoom, fit) and the same onScan() handler as the browser path.
  function startNativeScanner() {
    // 4:3 capture = WIDEST field of view (16:9 crops the sensor top/bottom and looks
    // zoomed). Resolution high enough for small EAN-13 bars. focusMode in advanced is
    // best-effort. Zoom is forced to widest after the stream is live (nativeCamTweaks).
    var constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 }, height: { ideal: 960 },
        advanced: [{ focusMode: 'continuous' }]
      }
    };
    navigator.mediaDevices.getUserMedia(constraints)
      .then(function (stream) {
        nativeStream = stream;
        videoTrack = (stream.getVideoTracks && stream.getVideoTracks()[0]) || null;
        var reader = $('reader');
        reader.innerHTML = '';
        var v = document.createElement('video');
        v.setAttribute('playsinline', ''); v.muted = true; v.autoplay = true;
        v.style.cssText = 'width:100%;height:100%';
        // Show the WHOLE camera frame (no cover-crop, which was the apparent "zoom").
        // setProperty/important beats the global `.reader video{object-fit:cover!important}`.
        v.style.setProperty('object-fit', 'contain', 'important');
        reader.appendChild(v);
        v.srcObject = stream;
        return v.play().catch(function () {}).then(function () { return v; });
      })
      .then(function (v) {
        usingNative = true; scanning = true; starting = false;
        $('viewfinder').classList.add('live');
        $('scan-toggle').textContent = t('stop_cam');
        var caps = (videoTrack && videoTrack.getCapabilities) ? videoTrack.getCapabilities() : {};
        nativeCamTweaks();                                   // widest zoom + continuous focus
        setTimeout(nativeCamTweaks, 1200);                   // re-assert after warm-up
        setTimeout(nativeCamTweaks, 2500);
        try { setupZoom(caps); } catch (e) {}
        startDetectLoop(v);
      })
      .catch(function (err) {
        starting = false; usingNative = false;
        $('tap-hint').textContent = t('tap_start');
        toast(cameraErrText(err), true);
        console.warn('native camera start failed', err);
      });
  }

  // Force the camera to its WIDEST view (zoom = min, normally 1×) and continuous
  // autofocus. Unconditional + best-effort: some phones don't advertise zoom/focus in
  // getCapabilities() but still honour the constraint, so we try regardless.
  function nativeCamTweaks() {
    if (!videoTrack || !videoTrack.applyConstraints) return;
    var caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    var adv = [{ focusMode: 'continuous' }];
    var z = (caps && caps.zoom && typeof caps.zoom.min === 'number') ? caps.zoom.min : 1;
    adv.push({ zoom: z });
    videoTrack.applyConstraints({ advanced: adv }).catch(function () {
      // zoom not accepted → at least keep continuous focus
      videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    });
  }

  function startDetectLoop(video) {
    var detector;
    try { detector = new window.BarcodeDetector({ formats: ['ean_13', 'code_128', 'ean_8', 'upc_a', 'qr_code'] }); }
    catch (e) { detector = new window.BarcodeDetector(); }
    clearTimeout(detectTimer);
    function tick() {
      if (!scanning || !usingNative) return;
      try {
        detector.detect(video)
          .then(function (codes) { if (codes && codes.length) onScan(codes[0].rawValue); })
          .catch(function () {});
      } catch (e) {}
      detectTimer = setTimeout(tick, 160);  // ~6 scans/sec — BarcodeDetector is native/fast
    }
    detectTimer = setTimeout(tick, 300);
  }

  // ---- Native ML Kit barcode scanner (Capacitor APK only) ----
  // startScan() renders the real camera BEHIND a transparent WebView and streams
  // detected barcodes via the 'barcodesScanned' event. We make the page transparent and
  // float a minimal overlay (aim frame + Stop) on top. On a hit we stop (to reveal the
  // app) and route the code through the same onScan() handler as every other path.
  var usingMlkit = false, mlkitListener = null;
  function nativeScanSupported() {
    return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanning);
  }
  function startMlkitScan() {
    var BS = window.Capacitor.Plugins.BarcodeScanning;
    BS.requestPermissions().then(function () {
      return BS.addListener('barcodesScanned', function (result) {
        var arr = result && result.barcodes;
        if (arr && arr.length) {
          var code = arr[0].rawValue || arr[0].displayValue;
          stopMlkitScan();          // reveal the app UI before showing the result
          if (code) onScan(code);
        }
      });
    }).then(function (listener) {
      mlkitListener = listener;
      usingMlkit = true; scanning = true; starting = false;
      document.documentElement.classList.add('native-scan');
      document.body.classList.add('native-scan');
      showScanOverlay();
      return BS.startScan();        // all formats, bundled on-device model
    }).catch(function (e) {
      starting = false;
      stopMlkitScan();
      toast(t('cam_error_prefix') + (e && (e.message || e.code || e)), true);
      console.warn('mlkit startScan failed', e);
    });
  }
  function stopMlkitScan() {
    var BS = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.BarcodeScanning : null;
    try { if (mlkitListener && mlkitListener.remove) mlkitListener.remove(); } catch (e) {}
    mlkitListener = null;
    try { if (BS) BS.stopScan(); } catch (e) {}
    document.documentElement.classList.remove('native-scan');
    document.body.classList.remove('native-scan');
    hideScanOverlay();
    usingMlkit = false; scanning = false;
    var tg = $('scan-toggle'); if (tg) tg.textContent = t('start_cam');
  }
  function showScanOverlay() {
    var o = $('native-scan-overlay');
    if (o) { o.style.display = 'flex'; return; }
    o = document.createElement('div');
    o.id = 'native-scan-overlay';
    o.className = 'native-scan-overlay';
    o.innerHTML =
      '<div class="ns-hint">' + t('point_camera') + '</div>' +
      '<div class="ns-frame"></div>' +
      '<button id="ns-stop" class="ns-stop">' + t('stop') + '</button>';
    document.body.appendChild(o);
    $('ns-stop').addEventListener('click', function () { stopMlkitScan(); });
  }
  function hideScanOverlay() { var o = $('native-scan-overlay'); if (o) o.style.display = 'none'; }

  // Turn a getUserMedia error into a message that says what's ACTUALLY wrong, instead
  // of always blaming permissions (which sent staff in circles re-allowing a camera
  // they'd already allowed). NotAllowed = truly blocked; NotReadable = busy; etc.
  function cameraErrText(err) {
    var n = (err && err.name) || '';
    if (!window.isSecureContext) return t('cam_insecure');
    if (n === 'NotAllowedError' || n === 'SecurityError') return t('cam_blocked');
    if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return t('cam_busy');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return t('cam_notfound');
    var detail = n || (err && err.message) || (typeof err === 'string' ? err : '');
    return t('cam_generic', { detail: (detail ? ' [' + String(detail).slice(0, 90) + ']' : '') });
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
      // Runs AFTER the camera is open, so it can never block opening. Best-effort:
      // continuous autofocus + a sharper resolution. We apply now and again once the
      // stream settles — some cameras only accept the focus constraint after warm-up.
      applyFocusAndRes(caps);
      setTimeout(function () { applyFocusAndRes(caps); }, 1200);
      setupZoom(caps);
      fitViewfinder();
    } catch (e) {}
  }

  // Size the viewfinder box to the camera's ACTUAL frame ratio. The preview <video>
  // uses object-fit:cover; in a fixed square box that center-crops ~40% off a 16:9
  // stream — the "zoomed in" complaint. Matching the box to videoWidth/videoHeight
  // makes cover crop nothing, so the preview shows the full field of view like the
  // native camera. Runs on loadedmetadata too, since dimensions arrive a beat late.
  function fitViewfinder() {
    var video = document.querySelector('#reader video');
    var card  = document.querySelector('.viewfinder-card');
    if (!video || !card) return;
    function apply() {
      var w = video.videoWidth, h = video.videoHeight;
      if (w && h) card.style.aspectRatio = w + ' / ' + h;
    }
    apply();
    video.addEventListener('loadedmetadata', apply, { once: true });
  }

  // Apply continuous focus (+720p) in ONE call so resolution doesn't reset focus.
  // We try focus unconditionally — some phones honour it without advertising it in
  // getCapabilities(). If the combined set is rejected, fall back to focus-only.
  function applyFocusAndRes(caps) {
    if (!videoTrack || !videoTrack.applyConstraints) return;
    var c = { advanced: [{ focusMode: 'continuous' }] };
    // 1080p, not 720p: small EAN-13 bars need more pixels per bar to decode,
    // especially on phones whose web camera focus is soft up close. NOT on iOS:
    // WebKit can freeze the live video when the resolution changes mid-stream,
    // leaving the decoder re-reading one stale frame forever.
    if (!IS_IOS && caps && caps.width && caps.height) {
      c.width  = { ideal: Math.min(1920, caps.width.max  || 1920) };
      c.height = { ideal: Math.min(1080, caps.height.max || 1080) };
    }
    try {
      videoTrack.applyConstraints(c).catch(function () {
        try { videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {}); } catch (e) {}
      });
    } catch (e) {}
  }

  // Optical/digital zoom slider — only shown when the camera reports a zoom range.
  // Lets staff read small or far-away barcodes without walking up to them.
  function setupZoom(caps) {
    var wrap = $('zoom-wrap'), range = $('zoom-range');
    if (!wrap || !range) return;
    if (!caps || !caps.zoom || !videoTrack || !(caps.zoom.max > caps.zoom.min)) { wrap.hidden = true; return; }
    range.min = caps.zoom.min; range.max = caps.zoom.max; range.step = caps.zoom.step || 0.1;
    // Force the WIDEST zoom (caps.zoom.min, normally 1×). Some phones hand back a
    // camera whose default zoom is already >1 (a cropped, soft, "zoomed-in" preview);
    // resetting to min gives the full field of view and the sharpest image. Staff can
    // still slide up to zoom in on small/far barcodes. "Zoom" is DIGITAL on single-lens
    // phones (crop + upscale), so min is always the cleanest starting point.
    range.value = caps.zoom.min;
    try { videoTrack.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] }).catch(function () {}); } catch (e) {}
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
      } else {
        // Phones that don't advertise focusMode (Huawei/Honor browsers) sometimes
        // still honour it — try unconditionally instead of giving up.
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
    } catch (e) {}
  }

  // Capture a STILL photo and decode that, instead of the live preview. On phones
  // whose preview stream never autofocuses (seen on Huawei/Honor in Chrome — blurry
  // at every distance), the still-capture pipeline runs the camera's real autofocus,
  // so the photo is sharp even when the preview isn't. This is the reliable path for
  // those phones; the continuous preview decode still handles everything else.
  var capturing = false;
  function captureAndDecode() {
    if (!videoTrack || capturing) return;
    capturing = true;
    refocus();                       // nudge AF first; takePhoto also focuses
    flashToast(t('focusing'));

    function decodeBitmap(bitmap) {
      if (!bitmap) throw new Error('no frame');
      var D = window.BarcodeDetector;
      if (D) {
        var det = new D({ formats: ['ean_13', 'code_128', 'ean_8', 'upc_a', 'qr_code'] });
        return det.detect(bitmap).then(function (codes) {
          if (codes && codes.length) { onScan(codes[0].rawValue); return true; }
          return false;
        });
      }
      // No detector available (shouldn't happen — polyfill loads one) → let html5-qrcode keep trying.
      return Promise.resolve(false);
    }

    // Prefer takePhoto() (full-res, properly focused still); fall back to grabFrame().
    var ic = (window.ImageCapture && videoTrack) ? new window.ImageCapture(videoTrack) : null;
    var got;
    if (ic && ic.takePhoto) {
      // Give AF ~600ms to settle after the refocus nudge before the shot.
      got = new Promise(function (res) { setTimeout(res, 600); })
        .then(function () { return ic.takePhoto(); })
        .then(function (blob) { return createImageBitmap(blob); })
        .catch(function () { return ic.grabFrame ? ic.grabFrame() : null; });
    } else if (ic && ic.grabFrame) {
      got = new Promise(function (res) { setTimeout(res, 600); }).then(function () { return ic.grabFrame(); });
    } else {
      // No ImageCapture API — this is EVERY iPhone (Safari never shipped it). Grab the
      // current frame off the live <video> onto a canvas instead. BarcodeDetector (the
      // ZXing polyfill on iOS) decodes a canvas directly, so tap-to-capture works here
      // too. Wait ~600ms first so the refocus() nudge above has time to sharpen.
      got = new Promise(function (res) { setTimeout(res, 600); }).then(function () {
        var video = document.querySelector('#reader video');
        if (!video || !video.videoWidth) return null;
        var cv = document.createElement('canvas');
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
        return cv;
      });
    }

    got.then(decodeBitmap)
      .then(function (found) { if (!found) flashToast(t('no_barcode')); })
      .catch(function () { flashToast(t('capture_fail')); })
      .finally(function () { capturing = false; });
  }

  function stopScanner() {
    if (usingMlkit) { stopMlkitScan(); return; }
    if (usingNative) {
      // Native path: stop the detector loop, release the camera, drop the video element.
      clearTimeout(detectTimer); detectTimer = null;
      try { if (nativeStream) nativeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      nativeStream = null; usingNative = false;
      var reader = $('reader'); if (reader) reader.innerHTML = '';
    } else if (qr && scanning) {
      try { qr.stop().then(function () { try { qr.clear(); } catch (e) {} }).catch(function () {}); } catch (e) {}
    }
    scanning = false;
    videoTrack = null;
    var card = document.querySelector('.viewfinder-card'); if (card) card.style.aspectRatio = '';
    var vf = $('viewfinder'); if (vf) vf.classList.remove('live');
    var zw = $('zoom-wrap'); if (zw) zw.hidden = true;
    var tg = $('scan-toggle'); if (tg) tg.textContent = t('start_cam');
  }

  $('scan-toggle').addEventListener('click', function () {
    ensureAudio();   // unlock sound on this user gesture (needed for iOS)
    if (scanning) stopScanner(); else startScanner();
  });
  // Tapping the viewfinder (re)starts the camera if stopped; while running it takes a
  // sharp still and decodes it — the reliable path for phones whose live preview won't
  // autofocus. (Phones that DO focus still auto-read continuously without any tap.)
  $('viewfinder').addEventListener('click', function () { ensureAudio(); if (!scanning) startScanner(); else captureAndDecode(); });

  // When the phone rotates, the video frame's dimensions swap — re-fit the viewfinder
  // (so it doesn't suddenly center-crop) and re-assert autofocus a beat later, once the
  // new orientation has settled. Guarded so it's a no-op while the camera is stopped.
  var orientTimer = null;
  function onOrientationChange() {
    if (!scanning) return;
    if (orientTimer) clearTimeout(orientTimer);
    orientTimer = setTimeout(function () {
      orientTimer = null;
      try { fitViewfinder(); } catch (e) {}
      try { var caps = videoTrack && videoTrack.getCapabilities ? videoTrack.getCapabilities() : {}; applyFocusAndRes(caps); } catch (e) {}
    }, 400);
  }
  window.addEventListener('orientationchange', onOrientationChange);
  window.addEventListener('resize', onOrientationChange);

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
    flashToast(t('looking_up', { code: decoded }));
    api('lookup', { barcode: decoded }).then(function (res) {
      setTimeout(function () { busy = false; }, CFG.SCAN_COOLDOWN_MS);
      if (handleUnauthorized(res)) return;
      if (res && res.found) {
        var p = normalizeProduct(res);
        if (p.barcode) barcodeIndex[p.barcode] = p; // cache for next time
        acceptScan(p, decoded);
      } else {
        flashToast(t('not_found_code', { code: decoded }));
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
    beep();
    flashToast('✓ ' + p.name);
  }

  // ── success beep (Web Audio — no file, works offline) ─────────────────────
  var audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      // iOS/Safari start the context suspended until a user gesture — resume it
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function beep() {
    try {
      ensureAudio();
      if (!audioCtx) return;
      var t = audioCtx.currentTime;
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 1000;          // crisp ~1 kHz "blip"
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01); // quick attack (no click)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.16);
    } catch (e) {}
  }
  // low "not found" buzz — two short descending low tones
  function buzz() {
    try {
      ensureAudio();
      if (!audioCtx) return;
      var t = audioCtx.currentTime;
      [220, 160].forEach(function (freq, i) {
        var s = t + i * 0.18;
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'square'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.22, s + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(s); o.stop(s + 0.17);
      });
    } catch (e) {}
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
    flashToast(t('looking_up', { code: code }));
    api('lookup', { barcode: code }).then(function (res) {
      if (handleUnauthorized(res)) return;
      if (res && res.found) {
        var p = normalizeProduct(res);
        if (p.barcode) barcodeIndex[p.barcode] = p;
        acceptScan(p, code);
        input.value = '';
      } else {
        flashToast(t('not_found_code', { code: code }));
        openNotFound(code);   // keep the typed code so they can correct it
      }
    });
  }
  var manualTimer = null;
  $('manual-form').addEventListener('submit', function (e) {
    e.preventDefault(); ensureAudio(); clearTimeout(manualTimer); manualLookup($('manual-code').value);
  });
  $('manual-code').addEventListener('input', function () {
    var el = $('manual-code');
    var v = el.value.replace(/\D/g, '');
    if (v !== el.value) el.value = v;        // digits only
    clearTimeout(manualTimer);
    // auto-fire only at a full UPC-A / EAN-13 length (12–13 digits); any other
    // length must be submitted with the Look up button.
    if (v.length === 12 || v.length === 13) {
      manualTimer = setTimeout(function () { manualLookup(v); }, 150);
    }
  });

  // ── session list ────────────────────────────────────────────────────────
  function renderSession() {
    $('session-count').textContent = String(sessionScans.length);
    var box = $('session-list');
    if (!sessionScans.length) {
      box.innerHTML = '';
      box.appendChild(emptyEl(t('session_empty')));
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
    if (!scanLog.length) { box.appendChild(emptyEl(t('log_empty'))); return; }
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
    sub.textContent = (e.sku ? t('sku') + ' ' + e.sku : '') + (e.barcode ? '  ·  ' + e.barcode : '');
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
    box.innerHTML = ''; box.appendChild(emptyEl(t('products_loading')));
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
    if (!list.length) { box.appendChild(emptyEl(t('products_empty'))); return; }
    list.forEach(function (p) {
      var card = document.createElement('button');
      card.className = 'pcard';
      var img = document.createElement('img');
      img.className = 'pcard-img'; img.loading = 'lazy'; img.alt = '';
      if (p.image) img.src = p.image;
      var body = document.createElement('div'); body.className = 'pcard-body';
      var nm = document.createElement('div'); nm.className = 'pcard-name'; nm.textContent = p.name || '(no name)';
      var sku = document.createElement('div'); sku.className = 'pcard-sku'; sku.textContent = p.sku ? t('sku') + ' ' + p.sku : '';
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
    $('pc-sku').textContent = p.sku ? t('sku') + ' ' + p.sku : 'SKU —';
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
    buzz();
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
    var btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = t('submitting');
    api('editRequest', data).then(function (res) {
      btn.disabled = false; btn.textContent = t('submit_request');
      if (handleUnauthorized(res)) return;
      if (res && res.ok) { closeSheet('sheet-edit'); toast(t('request_submitted')); }
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
      $('cred-title').textContent = credMode === 'username' ? t('change_username') : t('change_password');
      $('cred-new-label').textContent = credMode === 'username' ? t('new_username') : t('new_password');
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

    var btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = t('saving');
    var action = credMode === 'username' ? 'changeUsername' : 'changePassword';
    var params = credMode === 'username'
      ? { currentPassword: current, newUsername: next.trim() }
      : { currentPassword: current, newPassword: next };

    api(action, params).then(function (res) {
      btn.disabled = false; btn.textContent = t('save');
      if (handleUnauthorized(res)) return;
      if (res && res.ok) {
        if (credMode === 'username') {
          user.username = res.username;
          localStorage.setItem(KEYS.user, JSON.stringify(user));
          $('profile-username').textContent = user.username;
          greetName = user.username; renderGreeting();
        }
        closeSheet('sheet-cred');
        toast(t('saved'));
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
    // Auto-reload once when a NEW service worker takes control, so a deploy lands on
    // the phone without anyone manually clearing the cache. Only on UPDATES (a
    // controller already existed) — never on the very first install.
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController && !reloading) { reloading = true; window.location.reload(); }
    });
    // updateViaCache:'none' → the browser never serves sw.js from its HTTP cache, so a
    // new service worker is detected immediately on every load.
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {});
    });
  }
  if (token && user) enterApp(); else routeUnauthed();

})();
