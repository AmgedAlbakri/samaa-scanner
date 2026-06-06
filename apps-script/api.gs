/* ════════════════════════════════════════════════════════════════════════════
 *  SAMAA MAJU Scanner — JSON API layer  (paste this into the SAME Apps Script
 *  project as your existing Code.gs).  It ADDS new functions only; it does not
 *  change any existing menu/sidebar/pricing function.
 *
 *  It reuses your existing logic:
 *      bcLookupBarcode(barcode)   bcGetAllProducts()   bcSearchProducts(query)
 *  …and enriches each product with the §7 selling price.
 *
 *  DEPLOY:  Deploy ▸ New deployment ▸ Web app ▸ Execute as: Me ▸ Access: Anyone.
 *           Re-deploy a NEW VERSION after every change.
 *  SETUP :  Project Settings ▸ Script Properties ▸ add  PEPPER = <long random>.
 *           Users sheet: add column E "Salt" (data starts row 3, headers row 2).
 * ════════════════════════════════════════════════════════════════════════════ */

// ── Config you may need to change ───────────────────────────────────────────
var API_USERS_SHEET      = 'Users';
var API_USERS_FIRST_ROW  = 3;            // row 1 = title?, row 2 = headers, row 3 = first user
var API_EDIT_SHEET       = 'Edit Requests';
var API_SESSIONS_SHEET   = '_Sessions';  // hidden, auto-created
var API_SESSION_HOURS    = 12;

// §7 — the price column. Auto-detected by header text in row 4; override if needed.
var BC_PRICE_HEADER_LABEL = 'MY Shopee/Lazada — RM';  // ← change here if the sheet header text changes
var BC_PRICE_HEADER_ROW   = 4;
var BC_PRICE_COL_OVERRIDE = 0;            // ← set to a column number (e.g. 25 for "Y") to FORCE it; 0 = auto-detect

// Products sheet basics — fall back to sensible defaults if the globals from
// Code.gs are somehow not present (they normally are).
function _bcProductsSheetName_() { return (typeof BARCODE_SHEET  !== 'undefined') ? BARCODE_SHEET  : 'Products'; }
function _bcFirstDataRow_()      { return (typeof FIRST_DATA_ROW !== 'undefined') ? FIRST_DATA_ROW : 6; }
function _bcColSku_()             { return (typeof COL !== 'undefined' && COL.SKU) ? COL.SKU : 2; }
function _bcColCat_()             { return (typeof COL !== 'undefined' && COL.CAT) ? COL.CAT : 5; }

// ════════════════════════════════════════════════════════════════════════════
//  ROUTER
// ════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  return _json_({ ok: true, service: 'samaa-scanner-api' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return _json_({ ok: false, reason: 'bad_request' });   // never leak a stack trace
  }
  var action = req && req.action;
  var result;
  try {
    switch (action) {
      case 'login':           result = apiLogin_(req);           break;
      case 'lookup':          result = apiLookup_(req);          break;
      case 'search':          result = apiSearch_(req);          break;
      case 'allProducts':     result = apiAllProducts_(req);     break;
      case 'editRequest':     result = apiEditRequest_(req);     break;
      case 'changeUsername':  result = apiChangeUsername_(req);  break;
      case 'changePassword':  result = apiChangePassword_(req);  break;
      default:                result = { ok: false, reason: 'unknown_action' };
    }
  } catch (err) {
    result = { ok: false, reason: 'server_error' };          // never leak details
  }
  return _json_(result);
}

function _json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════════════
function apiLogin_(req) {
  var identifier = String(req.identifier || '').trim();
  var password   = String(req.password == null ? '' : req.password);
  if (!identifier || !password || password.length > 256) return { ok: false, reason: 'bad_credentials' };

  if (_isLocked_(identifier)) return { ok: false, reason: 'locked' };

  var u = _findUser_(identifier);
  if (!u) { _recordFail_(identifier); return { ok: false, reason: 'bad_credentials' }; }

  if (!_verifyPassword_(u, password)) { _recordFail_(identifier); return { ok: false, reason: 'bad_credentials' }; }

  if (!u.active) return { ok: false, reason: 'inactive' };

  _clearFails_(identifier);
  var token = _createSession_(u.username, u.email);
  return { ok: true, sessionToken: token, user: { username: u.username, email: u.email } };
}

function apiChangeUsername_(req) {
  var sess = _requireSession_(req); if (!sess.ok) return sess;
  var current = String(req.currentPassword == null ? '' : req.currentPassword);
  var newU    = String(req.newUsername || '').trim();

  if (!/^[A-Za-z0-9 ._-]{2,30}$/.test(newU)) return { ok: false, reason: 'invalid' };

  var u = _findUser_(sess.email) || _findUser_(sess.username);
  if (!u || !_verifyPassword_(u, current)) return { ok: false, reason: 'bad_password' };

  // duplicate check (case-insensitive) across all usernames
  var rows = _readUsers_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].row === u.row) continue;
    if (String(rows[i].username).toLowerCase() === newU.toLowerCase()) return { ok: false, reason: 'taken' };
  }

  var sh = _usersSheet_();
  sh.getRange(u.row, 2).setValue(_sanitizeCell_(newU)); // col B, formula-injection safe
  _renameSessions_(sess.token, newU);
  return { ok: true, username: newU };
}

function apiChangePassword_(req) {
  var sess = _requireSession_(req); if (!sess.ok) return sess;
  var current = String(req.currentPassword == null ? '' : req.currentPassword);
  var newP    = String(req.newPassword == null ? '' : req.newPassword);

  if (!newP || newP.length > 256) return { ok: false, reason: 'bad_password' }; // any strength accepted (§4.2)

  var u = _findUser_(sess.email) || _findUser_(sess.username);
  if (!u || !_verifyPassword_(u, current)) return { ok: false, reason: 'bad_password' };

  _writeHashedPassword_(u.row, newP);
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════════
//  PRODUCTS  (wrap existing bc* functions, add §7 price + category)
// ════════════════════════════════════════════════════════════════════════════
function apiLookup_(req) {
  var sess = _requireSession_(req); if (!sess.ok) return sess;
  var res = bcLookupBarcode(String(req.barcode || ''));
  if (!res || !res.found) return { found: false, msg: (res && res.msg) || 'Barcode not recognised.' };

  var info = _priceMap_()[res.sku] || {};
  return {
    found:   true,
    sku:     res.sku,
    name:    res.name,
    barcode: res.barcode,
    image:   res.imageUrl || '',
    price:   (info.price != null ? info.price : null),
    category: info.category || ''
  };
}

function apiAllProducts_(req) {
  var sess = _requireSession_(req); if (!sess.ok) return sess;
  return { ok: true, products: _enrich_(bcGetAllProducts()) };
}

function apiSearch_(req) {
  var sess = _requireSession_(req); if (!sess.ok) return sess;
  var list = bcSearchProducts(String(req.query || '')).slice(0, 50);
  return { ok: true, products: _enrich_(list) };
}

function _enrich_(list) {
  var map = _priceMap_();
  return (list || []).map(function (p) {
    var info = map[p.sku] || {};
    return {
      sku:      p.sku,
      name:     p.name,
      barcode:  p.barcode,
      image:    p.imageUrl || '',
      price:    (info.price != null ? info.price : null),
      category: info.category || ''
    };
  });
}

// §7 — resolve the "MY Shopee/Lazada — RM" column (first/leftmost match) and
// build a { sku: { price, category } } map in one batch read.
function _priceMap_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_bcProductsSheetName_());
  if (!sh) return {};
  var first = _bcFirstDataRow_();
  var last  = sh.getLastRow();
  if (last < first) return {};

  var priceCol = _resolvePriceCol_(sh);
  var n = last - first + 1;
  var skus = sh.getRange(first, _bcColSku_(), n, 1).getValues();
  var cats = sh.getRange(first, _bcColCat_(), n, 1).getValues();
  var prices = priceCol ? sh.getRange(first, priceCol, n, 1).getValues() : null;

  var map = {};
  for (var i = 0; i < n; i++) {
    var sku = String(skus[i][0] || '').trim();
    if (!sku) continue;
    var price = null;
    if (prices) {
      var v = prices[i][0];
      if (typeof v === 'number' && isFinite(v)) price = Math.round(v * 100) / 100;
      else if (v !== '' && v != null && !isNaN(Number(v))) price = Math.round(Number(v) * 100) / 100;
    }
    map[sku] = { price: price, category: String(cats[i][0] || '').trim() };
  }
  return map;
}

function _resolvePriceCol_(sh) {
  if (BC_PRICE_COL_OVERRIDE > 0) return BC_PRICE_COL_OVERRIDE;
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return 0;
  var header = sh.getRange(BC_PRICE_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  var target = _normHeader_(BC_PRICE_HEADER_LABEL);
  for (var c = 0; c < header.length; c++) {
    if (_normHeader_(header[c]) === target) return c + 1; // FIRST (leftmost) match — the green Selling Price block
  }
  return 0; // not found → price stays null (never crash, never guess cost)
}

// normalise so an em-dash vs hyphen / extra spaces / case never breaks the match
function _normHeader_(s) {
  return String(s == null ? '' : s)
    .replace(/[‒–—―−]/g, '-')  // figure/en/em dash & minus → "-"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ════════════════════════════════════════════════════════════════════════════
//  EDIT REQUESTS
// ════════════════════════════════════════════════════════════════════════════
function apiEditRequest_(req) {
  var sess = _requireSession_(req); if (!sess.ok) return sess;
  var sh = _ensureEditSheet_();
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kuala_Lumpur', 'yyyy-MM-dd HH:mm:ss');
  var row = [
    ts,
    _sanitizeCell_(sess.username),
    _sanitizeCell_(sess.email),
    _sanitizeCell_(_cap_(req.sku, 120)),
    _sanitizeCell_(_cap_(req.productName, 200)),
    _sanitizeCell_(_cap_(req.field, 40)),
    _sanitizeCell_(_cap_(req.currentValue, 500)),
    _sanitizeCell_(_cap_(req.newValue, 500)),
    _sanitizeCell_(_cap_(req.reason, 500)),
    'Pending',
    ''
  ];
  sh.appendRow(row);
  return { ok: true };
}

function _ensureEditSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(API_EDIT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(API_EDIT_SHEET);
    var hdr = ['Timestamp', 'Requested By', 'Email', 'SKU', 'Product Name', 'Field',
               'Current Value', 'Requested Value', 'Reason', 'Status', 'Reviewed By/Date'];
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr])
      .setFontWeight('bold').setBackground('#1F4E78').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ════════════════════════════════════════════════════════════════════════════
//  USERS  (sheet read + password hashing/migration §4.3)
// ════════════════════════════════════════════════════════════════════════════
function _usersSheet_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(API_USERS_SHEET);
  if (!sh) throw new Error('Users sheet missing');
  return sh;
}

function _readUsers_() {
  var sh = _usersSheet_();
  var last = sh.getLastRow();
  if (last < API_USERS_FIRST_ROW) return [];
  var n = last - API_USERS_FIRST_ROW + 1;
  var vals = sh.getRange(API_USERS_FIRST_ROW, 1, n, 5).getValues(); // A..E
  var out = [];
  for (var i = 0; i < n; i++) {
    var email = String(vals[i][0] || '').trim();
    var uname = String(vals[i][1] || '').trim();
    if (!email && !uname) continue;
    var actRaw = vals[i][3];
    var active = (actRaw === true) || String(actRaw).toLowerCase() === 'true';
    out.push({
      row: API_USERS_FIRST_ROW + i,
      email: email,
      username: uname,
      hash: String(vals[i][2] == null ? '' : vals[i][2]),
      active: active,
      salt: String(vals[i][4] == null ? '' : vals[i][4]).trim()
    });
  }
  return out;
}

function _findUser_(identifier) {
  identifier = String(identifier || '').trim().toLowerCase();
  if (!identifier) return null;
  var rows = _readUsers_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].email.toLowerCase() === identifier || rows[i].username.toLowerCase() === identifier) return rows[i];
  }
  return null;
}

function _pepper_() {
  return PropertiesService.getScriptProperties().getProperty('PEPPER') || '';
}

function _sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function _hash_(salt, password) {
  return _sha256Hex_(_pepper_() + ':' + salt + ':' + password);
}

// returns true if password matches; migrates legacy plaintext on first success
function _verifyPassword_(u, password) {
  var stored = String(u.hash || '');
  var isHashed = /^[0-9a-f]{64}$/i.test(stored) && u.salt;
  if (isHashed) {
    return _hash_(u.salt, password) === stored.toLowerCase();
  }
  // legacy plaintext → compare once, then upgrade to salted hash
  if (stored !== '' && stored === password) {
    _writeHashedPassword_(u.row, password);
    return true;
  }
  return false;
}

function _writeHashedPassword_(row, password) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  var sh = _usersSheet_();
  sh.getRange(row, 3).setValue(_hash_(salt, password)); // col C = hash (64-hex, injection-proof)
  sh.getRange(row, 5).setValue(salt);                   // col E = salt
}

// ════════════════════════════════════════════════════════════════════════════
//  SESSIONS  (hidden sheet, 12h expiry)
// ════════════════════════════════════════════════════════════════════════════
function _sessionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(API_SESSIONS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(API_SESSIONS_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['Token', 'Username', 'Email', 'ExpiryMs']]);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function _createSession_(username, email) {
  var sh = _sessionsSheet_();
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  var exp = Date.now() + API_SESSION_HOURS * 3600 * 1000;
  sh.appendRow([token, username, email, exp]);
  _pruneSessions_(sh);
  return token;
}

function _requireSession_(req) {
  var token = String(req && req.sessionToken || '');
  if (!token) return { ok: false, reason: 'unauthorized' };
  var sh = _sessionsSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, reason: 'unauthorized' };
  var vals = sh.getRange(2, 1, last - 1, 4).getValues();
  var now = Date.now();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === token) {
      if (Number(vals[i][3]) > now) {
        return { ok: true, token: token, username: String(vals[i][1]), email: String(vals[i][2]) };
      }
      return { ok: false, reason: 'unauthorized' }; // expired
    }
  }
  return { ok: false, reason: 'unauthorized' };
}

function _renameSessions_(token, newUsername) {
  var sh = _sessionsSheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === token) { sh.getRange(2 + i, 2).setValue(newUsername); return; }
  }
}

// drop expired rows so the sheet stays small
function _pruneSessions_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, 4).getValues();
  var now = Date.now();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (Number(vals[i][3]) <= now) sh.deleteRow(2 + i);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  BRUTE-FORCE THROTTLE (§4.5)  &  SANITISATION (§4.4)
// ════════════════════════════════════════════════════════════════════════════
function _failKey_(id) { return 'bc_fail_' + String(id).trim().toLowerCase(); }

function _isLocked_(id) {
  var n = CacheService.getScriptCache().get(_failKey_(id));
  return n && Number(n) >= 5;
}
function _recordFail_(id) {
  var key = _failKey_(id);
  var c = CacheService.getScriptCache();
  var n = Number(c.get(key) || 0) + 1;
  c.put(key, String(n), 600); // 10-minute window
}
function _clearFails_(id) { CacheService.getScriptCache().remove(_failKey_(id)); }

// neutralise a leading = + - @ tab or CR before any user text is written to a cell
function _sanitizeCell_(v) {
  var s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}
function _cap_(v, max) {
  var s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
