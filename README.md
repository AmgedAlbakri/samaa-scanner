# SAMAA MAJU Scanner — PWA

A free, installable barcode scanner for store staff. Scan a product → see its
**image, name, SKU and price** (read straight from your Pricing sheet), preview a
**discount %**, keep a **live multi-scan list**, browse **All Products** with search,
and submit **Edit Requests** to a Google Sheet. Read-only: staff can never edit product data.

Built as a **Progressive Web App** — no app stores, no Apple Developer account, **zero cost**.

```
samaa-scanner/
├── index.html        app shell (all screens)
├── styles.css        design system (§8)
├── app.js            client logic (auth, scan, products, log, profile)
├── config.js         ← paste your Web App URL here
├── manifest.json     installable metadata + icons
├── sw.js             service worker (offline shell)
├── brand/            logo + app icons (already copied in)
└── apps-script/
    └── api.gs        ← paste into your Google Sheet's Apps Script project
```

---

## Part A — Backend (Google Apps Script)

1. **Open the script.** In your “Pricing System v1” sheet: **Extensions ▸ Apps Script**.
2. **Add the API.** Create a new script file (e.g. `Api.gs`) and paste **all** of
   `apps-script/api.gs` into it. Do **not** edit your existing `Code.gs`. Save.
3. **Set the pepper.** **Project Settings ▸ Script Properties ▸ Add property**
   - Name: `PEPPER`
   - Value: a long random string (e.g. 40+ random characters). Keep it secret.
4. **Add the Salt column.** On the **`Users`** sheet, put the header **`Salt`** in
   **cell E2**. Leave the cells below blank — the server fills them automatically the
   first time each user logs in. Layout:

   | A | B | C | D | E |
   |---|---|---|---|---|
   | Email | Username | Password | Active (checkbox) | **Salt** |

   *Existing plaintext passwords keep working:* on the user’s next correct login the
   server transparently replaces the plaintext with a salted SHA-256 hash and writes the salt.
5. **Deploy as a Web App.** **Deploy ▸ New deployment ▸ Web app**
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy**, authorise, and **copy the `/exec` URL**.
   - ⚠️ Every time you later change the server code, do **Deploy ▸ Manage deployments ▸
     Edit ▸ Version: New version** (or a brand-new deployment), or the app keeps using the old code.

> The price comes **directly** from the Products header **`MY Shopee/Lazada — RM`**
> (the leftmost / green Selling-Price match in row 4) — never computed from cost.
> If your header text or position changes, edit the clearly-marked constants at the top
> of `api.gs` (`BC_PRICE_HEADER_LABEL`, or force a column with `BC_PRICE_COL_OVERRIDE`).

---

## Part B — Frontend (the PWA)

1. **Point it at your backend.** Open `config.js` and paste the `/exec` URL into
   `WEB_APP_URL`.
2. **Host it on a free HTTPS static host** (camera needs HTTPS). Any one of:
   - **GitHub Pages:** create a repo, upload the whole `samaa-scanner/` folder,
     **Settings ▸ Pages ▸ Deploy from branch ▸ /(root)**. Your URL is
     `https://<you>.github.io/<repo>/`.
   - **Netlify / Cloudflare Pages / Vercel:** drag-and-drop the `samaa-scanner/` folder
     (Netlify Drop is the fastest — just drop the folder).
   - Do **not** host inside the Apps Script iframe — its sandbox can block the camera.
3. **Open the hosted URL** on a phone over HTTPS.

### Install to the home screen (gets the SAMAA MAJU icon, launches fullscreen)

- **iPhone (Safari, iOS 16.4+):** open the URL ▸ **Share** ▸ **Add to Home Screen** ▸ Add.
- **Android (Chrome):** open the URL ▸ menu **⋮** ▸ **Add to Home screen / Install app**.

Open it from the new icon, log in once, and allow camera access when prompted.

---

## Security model (summary)
- **Passwords** are SHA-256 of `PEPPER : salt : password` (per-user salt). **Any password
  strength is accepted** on change — there is no length/complexity rule.
- **No client secrets** — auth is a server-issued session token (12 h), stored in `localStorage`.
- **Formula-injection guard** — any text written to a cell (username, edit requests) with a
  leading `= + - @`, tab or CR is neutralised with a `'` prefix.
- **Brute-force throttle** — 5 failed logins per identifier within 10 min → locked 10 min.
- **Output** is rendered as text (`textContent`), never `innerHTML`.

---

## Acceptance checks (§11.4)
- [ ] A known SKU shows the price from **`MY Shopee/Lazada — RM`** (not cost) + correct image/name/SKU + a barcode preview.
- [ ] An **inactive** user (Active unchecked) is blocked at login with “account is not active”.
- [ ] **6+ failed logins** for one identifier return `locked` for ~10 minutes.
- [ ] Changing password to a weak value like **`1234` is accepted**.
- [ ] Typing **`=HYPERLINK(...)`** as a username stores it as inert text (leading `'`).
- [ ] The **Scan screen accumulates a live multi-scan list** as you scan item after item.
- [ ] Submitting an edit request adds a new row to the **`Edit Requests`** sheet.
- [ ] The app **installs to the home screen** with the SAMAA MAJU icon and scans on a real iPhone + Android, at **zero cost**.

---

## Troubleshooting
- **Camera won’t open:** must be HTTPS; grant camera permission; on iOS use Safari (or the installed PWA).
- **“App is not configured”:** `WEB_APP_URL` in `config.js` is empty.
- **Login always fails / blank prices:** you changed server code but didn’t deploy a **new version**.
- **Price shows `RM —`:** the `MY Shopee/Lazada — RM` header text wasn’t found in row 4 — set `BC_PRICE_COL_OVERRIDE` in `api.gs`.
- **Old version after update:** bump the cache name in `sw.js` (`samaa-scanner-v1` → `-v2`) and redeploy.
