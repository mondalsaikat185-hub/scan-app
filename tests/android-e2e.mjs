// Android e2e test — runs on GitHub Actions inside a real Android emulator.
// It installs the APK, opens it, drives the WebView over Chrome DevTools Protocol,
// (raw Chrome DevTools Protocol over WebSocket — no extra libraries) and checks: app opens (no endless spinner), it is the native build, scanned files
// can be read, "+" opens the Google scanner (or fails cleanly — never hangs), and
// Back returns to the app. Writes test-out/report.json + screenshots + logcat.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PKG = 'in.sanvitools.scan';
const OUT = 'test-out';
mkdirSync(OUT, { recursive: true });
const sh = (c, opt = {}) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {}, notes: [] };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, detail }; console.log(ok ? 'PASS' : 'FAIL', name, detail ?? ''); };
const screencap = (name) => { try { sh(`adb exec-out screencap -p > ${OUT}/${name}.png`, { shell: '/bin/bash' }); } catch (e) { report.notes.push('screencap ' + name + ' failed'); } };
const topActivity = () => { try { return sh(`adb shell dumpsys activity activities | grep -m1 -E "mResumedActivity|topResumedActivity"`, { shell: '/bin/bash' }); } catch { return ''; } };

// ---- tiny CDP client (Node 22 has a global WebSocket) ----
async function cdpConnect() {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json();
      target = list.find((t) => t.type === 'page' && /scan\.sanvitools\.in|localhost|offline/.test(t.url)) || null;
    } catch { /* not yet */ }
    if (!target) await sleep(1000);
  }
  if (!target) throw new Error('no WebView page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { url: target.url, evaluate, logs, close: () => ws.close() };
}

let cdp;
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
  cdp = await cdpConnect();
  const ev = cdp.evaluate;
  report.url = cdp.url;

  // ---- 1. app opens to the library (no endless spinner) ----
  let homeOk = false;
  for (let i = 0; i < 90 && !homeOk; i++) {
    try { homeOk = await ev("!!document.querySelector('.lib-fab')"); } catch { /* page navigating */ }
    if (!homeOk) await sleep(1000);
  }
  const href = await ev('location.href').catch(() => '?');
  check('home_screen_loads', homeOk, `${Date.now() - t0} ms, url=${href}`);
  screencap('01_home');
  if (!homeOk) throw new Error('home did not load');

  // ---- 2. it is the native build ----
  const plat = await ev("({ native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()), platform: window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() })");
  check('capacitor_native_bridge', plat.native && plat.platform === 'android', JSON.stringify(plat));

  // ---- 3. app can read a file the scanner would write (convertFileSrc) ----
  sh('python3 -c "import base64;open(\'/tmp/t.jpg\',\'wb\').write(base64.b64decode(\'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==\'))"');
  sh('adb push /tmp/t.jpg /data/local/tmp/t.jpg');
  sh(`adb shell run-as ${PKG} sh -c "'mkdir -p cache && cp /data/local/tmp/t.jpg cache/t.jpg'"`, { shell: '/bin/bash' });
  const fileRes = await ev(`(async () => {
    try {
      const u = window.Capacitor.convertFileSrc('file:///data/user/0/${PKG}/cache/t.jpg');
      const r = await fetch(u); const b = await r.blob(); return { ok: r.ok, size: b.size, u };
    } catch (e) { return { ok: false, err: String(e) }; }
  })()`);
  check('read_scanned_file', fileRes.ok && fileRes.size > 100, JSON.stringify(fileRes));

  // ---- 4. "+" opens Google scanner, or fails cleanly within the watchdog ----
  await ev("document.querySelector('.lib-fab').click()");
  let scannerOpened = false, hung = false, outcome = '';
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const top = topActivity();
    if (top && !top.includes(PKG + '/')) { scannerOpened = true; outcome = top; break; }
    const ui = await ev("({ processing: /Processing…/.test(document.body.innerText), step: document.querySelector('.image-input-container') ? 'input' : document.querySelector('.lib-fab') ? 'library' : 'other' })").catch(() => null);
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
    const ui = await ev("({ processing: /Processing…/.test(document.body.innerText), library: !!document.querySelector('.lib-fab') })").catch(() => ({}));
    screencap('04_after_back');
    check('back_returns_to_app', back && !ui.processing, JSON.stringify(ui));
  }
  report.consoleTail = cdp.logs.slice(-40);
} catch (e) {
  report.error = String(e && e.stack || e);
  console.error(e);
} finally {
  try { writeFileSync(`${OUT}/logcat.txt`, sh(`adb logcat -d -v time | grep -E -i "Capacitor|chromium|DocumentScanner|AndroidRuntime|mlkit|${PKG}" | tail -400`, { shell: '/bin/bash', maxBuffer: 1 << 26 })); } catch { /* ignore */ }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  if (cdp) cdp.close();
  const failed = Object.entries(report.checks).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log('FAILED:', failed.join(', ') || 'none');
  process.exit(report.error || failed.length ? 1 : 0);
}
