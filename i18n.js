/* SAMAA MAJU Scanner — internationalisation (English / Arabic, with RTL)
 * Loaded BEFORE app.js. Exposes window.t(key, vars), window.applyLang(lang),
 * window.getLang(). Static text is translated via [data-i18n] / [data-i18n-ph]
 * attributes in index.html; app.js uses t() for dynamic strings and re-renders on
 * the 'langchange' event. Choice persists in localStorage. */
(function () {
  var STORE_KEY = 'samaa_lang';

  var I18N = {
    en: {
      // auth
      activate_title: 'Activate this device',
      activate_sub: 'Enter the one-time code from your administrator',
      activate_ph: 'Access code',
      activate_btn: 'Activate',
      activating: 'Activating…',
      device_activated: 'Device activated ✓',
      blocked_title: 'Device blocked',
      blocked_msg: 'This device has been blocked. Please contact your administrator.',
      login_title: 'Staff Scanner',
      login_sub: 'Sign in to continue',
      login_id_ph: 'Email or username',
      login_pw_ph: 'Password',
      login_btn: 'Log in',
      logging_in: 'Logging in…',
      // nav / titles
      nav_scan: 'Scan', nav_products: 'Products', nav_log: 'Log', nav_profile: 'Profile',
      // scan
      greeting: 'Hello, {name} 👋',
      tap_start: 'Tap to start the camera',
      live_hint: 'Blurry? Tap the image to capture & scan',
      start_cam: 'Start camera',
      stop_cam: 'Stop camera',
      manual_ph: "Can't scan? Type the barcode",
      look_up: 'Look up',
      this_session: 'This session',
      clear: 'Clear',
      session_empty: 'Scan a barcode to begin. Scans stack up here.',
      point_camera: 'Point the camera at a barcode',
      stop: 'Stop',
      focusing: 'Focusing…',
      no_barcode: 'No barcode — hold steady, tap again',
      capture_fail: 'Could not capture — tap again',
      looking_up: 'Looking up {code}…',
      not_found_code: '✗ Not found: {code}',
      scan_success: 'Scanned successfully ✅',
      // products
      search_ph: 'Search products, SKU…',
      products_loading: 'Loading products…',
      products_empty: 'No products found.',
      // log
      scan_history: 'Scan history',
      log_empty: 'No scans yet.',
      // profile
      change_username: 'Change username',
      change_password: 'Change password',
      log_out: 'Log out',
      // product sheet
      sku: 'SKU',
      price: 'Price',
      discount: 'Discount',
      after_discount: 'After discount',
      request_edit: 'Request edit',
      // not found
      nf_title: 'Barcode not recognised',
      nf_msg_pre: 'No product matches',
      nf_add: 'Request: add this product',
      // edit request
      edit_title: 'Request a change',
      product: 'Product',
      what_changing: 'What needs changing?',
      opt_name: 'Name', opt_price: 'Price', opt_image: 'Image', opt_barcode: 'Barcode', opt_other: 'Other',
      current_value: 'Current value',
      requested_value: 'Requested value',
      reason: 'Reason',
      submit_request: 'Submit request',
      submitting: 'Submitting…',
      request_submitted: 'Request submitted ✓',
      // credentials
      cred_current_pw: 'Current password',
      new_value: 'New value',
      new_username: 'New username',
      new_password: 'New password',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved ✓',
      // camera errors / misc
      scanner_failed: 'Scanner failed to load.',
      cam_insecure: 'Camera needs a secure (https) connection — open the app via its https link.',
      cam_blocked: 'Camera blocked. Allow camera access for this site in settings, then reload.',
      cam_busy: 'Camera is busy — close other apps using it, then tap Start camera again.',
      cam_notfound: 'No usable camera found — reload the page and try again.',
      cam_generic: 'Cannot open camera{detail} — reload and try again.',
      cam_error_prefix: 'Camera error: ',
      // session messages
      acc_deactivated: 'Your account has been deactivated — contact admin.',
      device_unauth: 'This device is no longer authorized.',
      session_expired: 'Session expired — please log in again.',
      lang_switch: 'العربية'
    },
    ar: {
      activate_title: 'تفعيل هذا الجهاز',
      activate_sub: 'أدخل رمز التفعيل لمرة واحدة من المسؤول',
      activate_ph: 'رمز الوصول',
      activate_btn: 'تفعيل',
      activating: 'جارٍ التفعيل…',
      device_activated: 'تم تفعيل الجهاز ✓',
      blocked_title: 'الجهاز محظور',
      blocked_msg: 'تم حظر هذا الجهاز. يرجى التواصل مع المسؤول.',
      login_title: 'ماسح الموظفين',
      login_sub: 'سجّل الدخول للمتابعة',
      login_id_ph: 'البريد الإلكتروني أو اسم المستخدم',
      login_pw_ph: 'كلمة المرور',
      login_btn: 'تسجيل الدخول',
      logging_in: 'جارٍ تسجيل الدخول…',
      nav_scan: 'مسح', nav_products: 'المنتجات', nav_log: 'السجل', nav_profile: 'الملف الشخصي',
      greeting: 'مرحباً، {name} 👋',
      tap_start: 'اضغط لتشغيل الكاميرا',
      live_hint: 'غير واضح؟ اضغط على الصورة للالتقاط والمسح',
      start_cam: 'تشغيل الكاميرا',
      stop_cam: 'إيقاف الكاميرا',
      manual_ph: 'لا يمكن المسح؟ اكتب رقم الباركود',
      look_up: 'بحث',
      this_session: 'هذه الجلسة',
      clear: 'مسح',
      session_empty: 'امسح باركود للبدء. ستظهر عمليات المسح هنا.',
      point_camera: 'وجّه الكاميرا نحو الباركود',
      stop: 'إيقاف',
      focusing: 'جارٍ ضبط التركيز…',
      no_barcode: 'لا يوجد باركود — ثبّت الكاميرا وحاول مجدداً',
      capture_fail: 'تعذّر الالتقاط — حاول مجدداً',
      looking_up: 'جارٍ البحث عن {code}…',
      not_found_code: '✗ غير موجود: {code}',
      scan_success: 'تم المسح بنجاح ✅',
      search_ph: 'ابحث عن منتج أو SKU…',
      products_loading: 'جارٍ تحميل المنتجات…',
      products_empty: 'لا توجد منتجات.',
      scan_history: 'سجل المسح',
      log_empty: 'لا توجد عمليات مسح بعد.',
      change_username: 'تغيير اسم المستخدم',
      change_password: 'تغيير كلمة المرور',
      log_out: 'تسجيل الخروج',
      sku: 'SKU',
      price: 'السعر',
      discount: 'الخصم',
      after_discount: 'بعد الخصم',
      request_edit: 'طلب تعديل',
      nf_title: 'باركود غير معروف',
      nf_msg_pre: 'لا يوجد منتج مطابق لـ',
      nf_add: 'طلب: إضافة هذا المنتج',
      edit_title: 'طلب تغيير',
      product: 'المنتج',
      what_changing: 'ما الذي يحتاج إلى تغيير؟',
      opt_name: 'الاسم', opt_price: 'السعر', opt_image: 'الصورة', opt_barcode: 'الباركود', opt_other: 'أخرى',
      current_value: 'القيمة الحالية',
      requested_value: 'القيمة المطلوبة',
      reason: 'السبب',
      submit_request: 'إرسال الطلب',
      submitting: 'جارٍ الإرسال…',
      request_submitted: 'تم إرسال الطلب ✓',
      cred_current_pw: 'كلمة المرور الحالية',
      new_value: 'القيمة الجديدة',
      new_username: 'اسم المستخدم الجديد',
      new_password: 'كلمة المرور الجديدة',
      save: 'حفظ',
      saving: 'جارٍ الحفظ…',
      saved: 'تم الحفظ ✓',
      scanner_failed: 'فشل تحميل الماسح.',
      cam_insecure: 'تحتاج الكاميرا إلى اتصال آمن (https) — افتح التطبيق عبر رابط https.',
      cam_blocked: 'الكاميرا محظورة. اسمح بالوصول إلى الكاميرا لهذا الموقع من الإعدادات ثم أعد التحميل.',
      cam_busy: 'الكاميرا مشغولة — أغلق التطبيقات الأخرى التي تستخدمها ثم اضغط تشغيل الكاميرا مجدداً.',
      cam_notfound: 'لم يتم العثور على كاميرا صالحة — أعد تحميل الصفحة وحاول مجدداً.',
      cam_generic: 'تعذّر فتح الكاميرا{detail} — أعد التحميل وحاول مجدداً.',
      cam_error_prefix: 'خطأ في الكاميرا: ',
      acc_deactivated: 'تم تعطيل حسابك — تواصل مع المسؤول.',
      device_unauth: 'لم يعد هذا الجهاز مُصرّحاً به.',
      session_expired: 'انتهت الجلسة — يرجى تسجيل الدخول مجدداً.',
      lang_switch: 'English'
    }
  };

  var lang = (function () {
    try { var s = localStorage.getItem(STORE_KEY); if (s === 'en' || s === 'ar') return s; } catch (e) {}
    // default to Arabic if the device language is Arabic, else English
    return (navigator.language || '').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
  })();

  function t(key, vars) {
    var dict = I18N[lang] || I18N.en;
    var s = (dict[key] != null) ? dict[key] : (I18N.en[key] != null ? I18N.en[key] : key);
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }

  function translateStatic() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  function applyLang(next) {
    if (next && (next === 'en' || next === 'ar')) lang = next;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
    var html = document.documentElement;
    html.setAttribute('lang', lang);
    html.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    translateStatic();
    var toggle = document.getElementById('lang-toggle');
    if (toggle) toggle.textContent = t('lang_switch');
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  window.t = t;
  window.getLang = function () { return lang; };
  window.applyLang = applyLang;

  function init() {
    var toggle = document.getElementById('lang-toggle');
    if (toggle) toggle.addEventListener('click', function () { applyLang(lang === 'en' ? 'ar' : 'en'); });
    applyLang(lang);
    // Retire the launch splash once its fade-out animation has finished, so it stops
    // intercepting taps. (CSS fades it at 1.5s over .5s; remove just after.)
    var splash = document.getElementById('app-splash');
    if (splash) setTimeout(function () { splash.remove(); }, 2150);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
