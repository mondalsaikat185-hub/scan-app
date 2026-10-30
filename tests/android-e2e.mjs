// Android e2e test — runs on GitHub Actions inside a real Android emulator.
// It installs the APK, opens it, drives the WebView over Chrome DevTools Protocol,
// and checks: app opens (no endless spinner), it is the native build, scanned files
// can be read, "+" opens the Google scanner (or fails cleanly — never hangs), and
// Back returns to the app. Writes test-out/report.json + screenshots + logcat.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PKG = 'in.sanvitools.scan';
const OUT = 'test-out';
mkdirSync(OUT, { recursive: true });
const sh = (c, opt = {}) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {}, notes: [] };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, detail }; console.log(ok ? 'PASS' : 'FAIL', name, detail ?? ''); };
const screencap = (name) => { try { sh(`adb exec-out screencap -p > ${OUT}/${name}.png`, { shell: '/bin/bash' }); } catch (e) { report.notes.push('screencap ' + name + ' failed'); } };
const topActivity = () => { try { return sh(`adb shell dumpsys activity activities | grep -m1 -E "mResumedActivity|topResumedActivity"`, { shell: '/bin/bash' }); } catch { return ''; } };

let browser;
try {
  sh(`adb install -r ${process.argv[2] || 'out/ScanApp.apk'}`);
  sh('adb logcat -c');
  const t0 = Date.now();
  sh(`adb shell am start -W -n ${PKG}/.MainActivity`);

  // ---- WebView devtools socket ----
  let sock = '';
  for (let i = 0; i < 60 && !sock; i++) {
    try { sock = sh(`adb shell cat /proc/net/unix | grep -a -o "webview_devtools_remote_[0-9]*" | head -1`, { shell: '/bin/bash' }); } catch { /* not yet */ }
    if (!sock) await sleep(1000);
  }
  check('webview_debug_socket', !!sock, sock);
  sh(`adb forward tcp:9222 localabstract:${sock}`);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    page = ctx.pages().find((p) => /scan\.sanvitools\.in|localhost/.test(p.url())) || null;
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error('no WebView page found');
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  report.url = page.url();

  // ---- 1. app opens to the library (no endless spinner) ----
  let homeOk = false;
  try { await page.waitForSelector('.lib-fab', { timeout: 90000 }); homeOk = true; } catch { /* fail below */ }
  check('home_screen_loads', homeOk, `${Date.now() - t0} ms, url=${page.url()}`);
  screencap('01_home');
  if (!homeOk) throw new Error('home did not load');

  // ---- 2. it is the native build ----
  const plat = await page.evaluate(() => ({ native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()), platform: window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() }));
  check('capacitor_native_bridge', plat.native && plat.platform === 'android', JSON.stringify(plat));

  // ---- 3. app can read a file the scanner would write (convertFileSrc) ----
  sh('python3 -c "import base64;open(\'/tmp/t.jpg\',\'wb\').write(base64.b64decode(\'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==\'))"');
  sh('adb push /tmp/t.jpg /data/local/tmp/t.jpg');
  sh(`adb shell run-as ${PKG} sh -c "'mkdir -p cache && cp /data/local/tmp/t.jpg cache/t.jpg'"`, { shell: '/bin/bash' });
  const fileRes = await page.evaluate(async (pkg) => {
    try {
      const u = window.Capacitor.convertFileSrc(`file:///data/user/0/${pkg}/cache/t.jpg`);
      const r = await fetch(u); const b = await r.blob(); return { ok: r.ok, size: b.size, u };
    } catch (e) { return { ok: false, err: String(e) }; }
  }, PKG);
  check('read_scanned_file', fileRes.ok && fileRes.size > 100, JSON.stringify(fileRes));

  // ---- 4. "+" opens Google scanner, or fails cleanly within the watchdog ----
  await page.click('.lib-fab');
  let scannerOpened = false, hung = false, outcome = '';
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const top = topActivity();
    if (top && !top.includes(PKG + '/')) { scannerOpened = true; outcome = top; break; }
    const ui = await page.evaluate(() => ({ processing: /Processing…/.test(document.body.innerText), step: document.querySelector('.image-input-container') ? 'input' : document.querySelector('.lib-fab') ? 'library' : 'other' })).catch(() => null);
    if (ui && ui.step === 'input') { outcome = 'fell back to classic flow (scanner unavailable)'; break; }
    if (i === 24) { hung = true; outcome = JSON.stringify(ui) + ' top=' + top; }
  }
  screencap('02_after_plus');
  check('plus_does_not_hang', !hung, outcome);
  report.scannerOpened = scannerOpened;
  if (!scannerOpened) report.notes.push('Google scanner did not open in the emulator: ' + outcome);

  // ---- 5. Back from scanner returns to the app (no stuck overlay) ----
  if (scannerOpened) {
    await sleep(3000);
    screencap('03_scanner');
    sh('adb shell input keyevent KEYCODE_BACK'); await sleep(1500);
    // the scanner may ask "discard?" — press back again
    if (!topActivity().includes(PKG + '/')) { sh('adb shell input keyevent KEYCODE_BACK'); await sleep(1500); }
    const back = topActivity().includes(PKG + '/');
    await sleep(2000);
    const ui = await page.evaluate(() => ({ processing: /Processing…/.test(document.body.innerText), library: !!document.querySelector('.lib-fab') })).catch(() => ({}));
    screencap('04_after_back');
    check('back_returns_to_app', back && !ui.processing, JSON.stringify(ui));
  }
  report.consoleTail = logs.slice(-40);
} catch (e) {
  report.error = String(e && e.stack || e);
  console.error(e);
} finally {
  try { writeFileSync(`${OUT}/logcat.txt`, sh(`adb logcat -d -v time | grep -E -i "Capacitor|chromium|DocumentScanner|AndroidRuntime|mlkit|${PKG}" | tail -400`, { shell: '/bin/bash', maxBuffer: 1 << 26 })); } catch { /* ignore */ }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  if (browser) await browser.close().catch(() => {});
  const failed = Object.entries(report.checks).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log('FAILED:', failed.join(', ') || 'none');
  process.exit(report.error || failed.length ? 1 : 0);
}
