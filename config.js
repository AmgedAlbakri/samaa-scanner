/* SAMAA MAJU Scanner — configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 1 of deployment: paste your Apps Script Web App URL below.
 *
 *   Apps Script editor → Deploy → New deployment → Web app
 *     Execute as:  Me
 *     Who has access:  Anyone
 *   Copy the "/exec" URL it gives you and paste it between the quotes.
 *
 * Re-deploy a NEW VERSION every time you change the server code, or the app
 * will keep hitting the old one.
 * ─────────────────────────────────────────────────────────────────────────── */
window.SAMAA_CONFIG = {
  // e.g. "https://script.google.com/macros/s/AKfycbx....../exec"
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbwo8Qk-_tLUdjJu8ejaUsDBe1XFmQaRAlFif8NFcsv3WW6F-x2nQws0UStPXiDmvLHayA/exec",

  // Cooldown (ms) before the scanner re-arms after a successful read.
  SCAN_COOLDOWN_MS: 1500,

  // Session is restored from localStorage; the server still enforces a 12h expiry.
  STORAGE_KEYS: {
    token: "samaa_token",
    user: "samaa_user",
    log: "samaa_scanlog"
  }
};
