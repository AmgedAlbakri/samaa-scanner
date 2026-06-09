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
var API_DEVICES_SHEET    = '_Devices';   // hidden, auto-created — device enrollment/block ledger
var API_SESSION_HOURS    = 12;

// Device gate (one-time code per user, one device per user). OFF until the admin
// has generated codes (bcDeviceGenerateCodes) and enrolled their own phone, so
// enabling it never locks everyone out at once. Toggle via Script Property
// DEVICE_GATE = on|off (default off).  Users sheet: col F = Device Code, col G = Enrolled Device.
var API_DEVICE_FAILS      = 5;                 // wrong codes before a block
var API_DEVICE_BLOCK_MS   = 60 * 60 * 1000;    // 1-hour temporary block

function _deviceGateOn_() {
  var v = String(PropertiesService.getScriptProperties().getProperty('DEVICE_GATE') || '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

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
      case 'deviceStatus':    result = apiDeviceStatus_(req);    break;
      case 'enrollDevice':    result = apiEnrollDevice_(req);    break;
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

  // Device gate: this phone must already be enrolled to THIS user (one device/user).
  if (_deviceGateOn_()) {
    var dev = String(req.deviceId || '').trim();
    if (!dev || dev !== u.deviceId) return { ok: false, reason: 'device_not_enrolled' };
  }

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

// Cached price map: server-side lookups/allProducts re-scan the whole Products
// sheet otherwise. Short 2-min cache keeps scans snappy; prices refresh quickly
// enough for a scanner. Size-guarded (CacheService caps a value at ~100 KB).
function _priceMap_() {
  var cache = CacheService.getScriptCache();
  try { var hit = cache.get('bc_pricemap'); if (hit) return JSON.parse(hit); } catch (e) {}
  var map = _priceMapBuild_();
  try {
    var s = JSON.stringify(map);
    if (s.length <= 90000) cache.put('bc_pricemap', s, 120);
  } catch (e) {}
  return map;
}

// §7 — resolve the "MY Shopee/Lazada — RM" column (first/leftmost match) and
// build a { sku: { price, category } } map in one batch read.
function _priceMapBuild_() {
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
  var vals = sh.getRange(API_USERS_FIRST_ROW, 1, n, 7).getValues(); // A..G
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
      salt: String(vals[i][4] == null ? '' : vals[i][4]).trim(),
      deviceCode: String(vals[i][5] == null ? '' : vals[i][5]).trim(), // col F
      deviceId:   String(vals[i][6] == null ? '' : vals[i][6]).trim()  // col G
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
        var uname = String(vals[i][1]), email = String(vals[i][2]);
        // Re-check the user every request so deactivating them (Active unchecked) or
        // un-enrolling their device logs them out on their next action.
        var u = _findUser_(email) || _findUser_(uname);
        if (u && !u.active) return { ok: false, reason: 'inactive' };
        if (u && _deviceGateOn_()) {
          var dev = String(req && req.deviceId || '').trim();
          if (!dev || dev !== u.deviceId) return { ok: false, reason: 'device_revoked' };
        }
        return { ok: true, token: token, username: uname, email: email };
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
//  DEVICE GATE  (one-time per-user code, one device per user, abuse lockout)
//  Users sheet:  col F = Device Code (one-time)   col G = Enrolled Device (deviceId)
//  _Devices:     A DeviceId | B Status | C Owner | D FailCount | E BlockedUntil | F LastSeen
// ════════════════════════════════════════════════════════════════════════════
function apiDeviceStatus_(req) {
  if (!_deviceGateOn_()) return { ok: true, state: 'enrolled' };   // gate off → behave as before
  var dev = String(req && req.deviceId || '').trim();
  if (!dev) return { ok: true, state: 'unenrolled' };
  var bs = _deviceBlockState_(dev);
  if (bs.blocked) return { ok: true, state: 'blocked', until: bs.forever ? 0 : bs.until };
  var users = _readUsers_();
  for (var i = 0; i < users.length; i++) {
    if (users[i].deviceId && users[i].deviceId === dev) return { ok: true, state: 'enrolled' };
  }
  return { ok: true, state: 'unenrolled' };
}

function apiEnrollDevice_(req) {
  if (!_deviceGateOn_()) return { ok: true, state: 'enrolled' };
  var dev  = String(req && req.deviceId || '').trim();
  var code = String(req && req.code || '').trim();
  if (!dev) return { ok: false, reason: 'bad_request' };

  var bs = _deviceBlockState_(dev);
  if (bs.blocked) return { ok: false, state: 'blocked', until: bs.forever ? 0 : bs.until };

  var users = _readUsers_();
  // already enrolled on this device → idempotent success
  for (var j = 0; j < users.length; j++) {
    if (users[j].deviceId && users[j].deviceId === dev) return { ok: true, state: 'enrolled' };
  }
  if (!code) return { ok: false, reason: 'bad_code', attemptsLeft: _deviceAttemptsLeft_(dev) };

  // a code works once: match a user whose code == code AND who has no device yet
  var match = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].deviceCode && users[i].deviceCode === code && !users[i].deviceId) { match = users[i]; break; }
  }
  if (!match) {
    var left = _deviceRecordFail_(dev);   // increments; blocks for 1h at the limit
    if (left <= 0) { var b = _deviceBlockState_(dev); return { ok: false, state: 'blocked', until: b.forever ? 0 : b.until }; }
    return { ok: false, reason: 'bad_code', attemptsLeft: left };
  }

  var sh = _usersSheet_();
  sh.getRange(match.row, 7).setValue(_sanitizeCell_(dev)); // col G ← bind device
  sh.getRange(match.row, 6).setValue('');                  // col F ← consume the one-time code
  _deviceClear_(dev);
  _deviceSetEnrolled_(dev, match.username || match.email);
  return { ok: true, state: 'enrolled' };
}

// ── _Devices ledger ─────────────────────────────────────────────────────────
function _devicesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(API_DEVICES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(API_DEVICES_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([['Device ID', 'Status', 'Owner', 'Fail Count', 'Blocked Until', 'Last Seen']]);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function _deviceFindRow_(dev) {
  var sh = _devicesSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]) === dev) return 2 + i; }
  return 0;
}

function _deviceUpsertRow_(dev) {
  var row = _deviceFindRow_(dev);
  if (row) return row;
  var sh = _devicesSheet_();
  sh.appendRow([dev, '', '', 0, 0, _nowStr_()]);
  return sh.getLastRow();
}

// returns { blocked, forever, until }; auto-clears an expired temporary block
function _deviceBlockState_(dev) {
  var row = _deviceFindRow_(dev);
  if (!row) return { blocked: false, forever: false, until: 0 };
  var sh = _devicesSheet_();
  var status = String(sh.getRange(row, 2).getValue() || '').trim().toLowerCase();
  var until  = Number(sh.getRange(row, 5).getValue() || 0);
  if (status === 'blocked_forever') return { blocked: true, forever: true, until: 0 };
  if (status === 'blocked') {
    if (until > Date.now()) return { blocked: true, forever: false, until: until };
    sh.getRange(row, 2).setValue('');  // expired → clear block + fail count
    sh.getRange(row, 4).setValue(0);
    sh.getRange(row, 5).setValue(0);
  }
  return { blocked: false, forever: false, until: 0 };
}

function _deviceAttemptsLeft_(dev) {
  var row = _deviceFindRow_(dev);
  if (!row) return API_DEVICE_FAILS;
  var fails = Number(_devicesSheet_().getRange(row, 4).getValue() || 0);
  return Math.max(0, API_DEVICE_FAILS - fails);
}

// increment fail count; block for 1h at the limit. Returns attempts left.
function _deviceRecordFail_(dev) {
  var sh = _devicesSheet_();
  var row = _deviceUpsertRow_(dev);
  var fails = Number(sh.getRange(row, 4).getValue() || 0) + 1;
  sh.getRange(row, 4).setValue(fails);
  sh.getRange(row, 6).setValue(_nowStr_());
  if (fails >= API_DEVICE_FAILS) {
    sh.getRange(row, 2).setValue('blocked');
    sh.getRange(row, 5).setValue(Date.now() + API_DEVICE_BLOCK_MS);
    return 0;
  }
  return API_DEVICE_FAILS - fails;
}

function _deviceClear_(dev) {
  var row = _deviceFindRow_(dev);
  if (!row) return;
  var sh = _devicesSheet_();
  sh.getRange(row, 2).setValue('');  // status
  sh.getRange(row, 4).setValue(0);   // fail count
  sh.getRange(row, 5).setValue(0);   // blocked until
}

function _deviceSetEnrolled_(dev, owner) {
  var sh = _devicesSheet_();
  var row = _deviceUpsertRow_(dev);
  sh.getRange(row, 2).setValue('enrolled');
  sh.getRange(row, 3).setValue(_sanitizeCell_(String(owner || '')));
  sh.getRange(row, 6).setValue(_nowStr_());
}

function _nowStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kuala_Lumpur', 'yyyy-MM-dd HH:mm:ss');
}

function _genDeviceCode_() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
  var s = '';
  for (var i = 0; i < 8; i++) s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return s.slice(0, 4) + '-' + s.slice(4); // e.g. "K7P2-9QXM"
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN HELPERS — run these from the Apps Script editor (Run ▸ pick a function)
// ════════════════════════════════════════════════════════════════════════════

// One-time: add the Users F/G headers and create the hidden _Devices sheet.
function bcDeviceSetup() {
  var sh = _usersSheet_();
  var hdrRow = API_USERS_FIRST_ROW - 1; // headers are the row above the first user
  if (!String(sh.getRange(hdrRow, 6).getValue() || '').trim()) sh.getRange(hdrRow, 6).setValue('Device Code');
  if (!String(sh.getRange(hdrRow, 7).getValue() || '').trim()) sh.getRange(hdrRow, 7).setValue('Enrolled Device');
  _devicesSheet_();
  Logger.log('Device gate setup done. Now run bcDeviceGenerateCodes(), then set Script Property DEVICE_GATE=on.');
}

// Issue a one-time code to every ACTIVE user who has no code and no enrolled device.
// Reads back the codes so you can hand each staffer theirs.
function bcDeviceGenerateCodes() {
  var sh = _usersSheet_();
  var users = _readUsers_();
  var issued = [];
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (!u.active) continue;
    if (u.deviceCode || u.deviceId) continue;     // already has a code, or already enrolled
    var code = _genDeviceCode_();
    sh.getRange(u.row, 6).setValue(code);          // col F
    issued.push((u.username || u.email) + '  →  ' + code);
  }
  Logger.log(issued.length ? ('Issued codes:\n' + issued.join('\n')) : 'No codes needed (all active users already have a code or device).');
  return issued;
}

// Replacement phone / re-enroll: clear the user's device and issue a fresh code.
function bcDeviceReissue(identifier) {
  var u = _findUser_(identifier);
  if (!u) { Logger.log('No user matching: ' + identifier); return; }
  var sh = _usersSheet_();
  if (u.deviceId) { _deviceClear_(u.deviceId); }   // free the old device's ledger row
  sh.getRange(u.row, 7).setValue('');               // clear enrolled device (col G)
  var code = _genDeviceCode_();
  sh.getRange(u.row, 6).setValue(code);             // new one-time code (col F)
  Logger.log('Reissued code for ' + (u.username || u.email) + '  →  ' + code);
  return code;
}

// Reset a blocked device so it can try again.
function bcDeviceUnblock(deviceId) {
  _deviceClear_(String(deviceId || '').trim());
  Logger.log('Unblocked device: ' + deviceId);
}

// Permanently block a device (survives the 1-hour auto-unblock).
function bcDeviceBlockForever(deviceId) {
  var dev = String(deviceId || '').trim();
  if (!dev) return;
  var sh = _devicesSheet_();
  var row = _deviceUpsertRow_(dev);
  sh.getRange(row, 2).setValue('blocked_forever');
  sh.getRange(row, 5).setValue(0);
  Logger.log('Blocked forever: ' + dev);
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
