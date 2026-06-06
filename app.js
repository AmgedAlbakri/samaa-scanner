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

  // in-memory caches
  var allProducts = [];          // for Products screen + search
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
    var payload = Object.assign({ action: action }, params || {});
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

  // any authenticated call may report the session died → bounce to login
  function handleUnauthorized(res) {
    if (res && res.reason === 'unauthorized') { doLogout('Session expired — please log in again.'); return true; }
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
  }

  function showLogin() {
    stopScanner();
    $('app').hidden = true;
    $('screen-login').classList.add('active');
  }

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
    showLogin();
    if (msg) toast(msg, true);
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

  function startScanner() {
    if (scanning) return;
    if (!window.Html5Qrcode) { toast('Scanner failed to load.', true); return; }
    qr = qr || new Html5Qrcode('reader', { formatsToSupport: supportedFormats(), verbose: false });
    var cfg = {
      fps: 10,
      qrbox: function (w, h) { var m = Math.floor(Math.min(w, h) * 0.7); return { width: m, height: Math.floor(m * 0.6) }; },
      aspectRatio: 1.0
    };
    qr.start({ facingMode: 'environment' }, cfg, onScan, function () { /* per-frame decode misses: ignore */ })
      .then(function () { scanning = true; $('scan-toggle').textContent = 'Stop camera'; })
      .catch(function (err) {
        toast('Cannot open camera. Allow camera access.', true);
        console.warn('camera start failed', err);
      });
  }

  function stopScanner() {
    if (qr && scanning) {
      try { qr.stop().then(function () { qr.clear(); }).catch(function () {}); } catch (e) {}
    }
    scanning = false;
    var t = $('scan-toggle'); if (t) t.textContent = 'Start camera';
  }

  $('scan-toggle').addEventListener('click', function () {
    if (scanning) stopScanner(); else startScanner();
  });

  function onScan(decoded) {
    var now = Date.now();
    // ignore an immediate duplicate of the same code, and respect a global cooldown
    if (busy) return;
    if (decoded === lastCode && now - lastAt < 2500) return;
    if (now - lastAt < CFG.SCAN_COOLDOWN_MS) return;
    lastCode = decoded; lastAt = now; busy = true;

    flashToast('Looking up ' + decoded + '…');
    api('lookup', { barcode: decoded }).then(function (res) {
      // re-arm after a short cooldown regardless of result (hands-free)
      setTimeout(function () { busy = false; }, CFG.SCAN_COOLDOWN_MS);
      if (handleUnauthorized(res)) return;

      if (res && res.found) {
        var p = normalizeProduct(res);
        var entry = {
          sku: p.sku, name: p.name, barcode: p.barcode || decoded,
          image: p.image, price: p.price, at: Date.now()
        };
        sessionScans.unshift(entry);
        renderSession();
        pushLog(entry);
        flashToast('✓ ' + p.name);
      } else {
        flashToast('✗ Not found: ' + decoded);
        openNotFound(decoded);
      }
    });
  }

  function flashToast(msg) {
    var t = $('scan-toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(function () { t.hidden = true; }, 1600);
  }

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
    // we already have enough to render, but re-lookup for the freshest price/image
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
    updateDiscount();
    renderBarcodePreview(p.barcode);
    openSheet('sheet-product');
  }

  function updateDiscount() {
    $('disc-val').textContent = discount + '%';
    var p = currentProduct;
    if (p && p.price != null) {
      var f = p.price * (1 - discount / 100);
      $('pc-final').textContent = 'RM ' + fmt(f);
    } else {
      $('pc-final').textContent = 'RM —';
    }
  }
  $('disc-minus').addEventListener('click', function () { discount = Math.max(0, discount - 5); updateDiscount(); });
  $('disc-plus').addEventListener('click', function () { discount = Math.min(95, discount + 5); updateDiscount(); });

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
  if (token && user) enterApp(); else showLogin();

})();
