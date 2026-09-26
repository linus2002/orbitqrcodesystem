#!/usr/bin/env node
/**
 * End-to-end browser tests.
 *
 *   npm run test:e2e
 *
 * Drives the real React app in headless Chrome over the DevTools Protocol.
 * This is deliberately separate from `npm test`: the unit and integration
 * suites must run anywhere, including CI without a browser, whereas this
 * needs Chrome and a built frontend.
 *
 * It starts its own API server on an ephemeral port against a temporary
 * database, so it never touches development data.
 *
 * Chrome is driven directly rather than through Playwright or Puppeteer,
 * because Node 22+ ships a WebSocket client and CDP is a stable protocol -
 * which keeps a ~300 MB browser download out of the dependency tree.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the pathname keeps spaces as %20, so a
// checkout under a folder with a space in its name was never found.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Locating Chrome
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Tiny CDP client
// ---------------------------------------------------------------------------

const sleep = async (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.problems = [];

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.problems.push(
          `console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`
        );
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.problems.push(
          `exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`
        );
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.problems.push(`${m.params.entry.source}: ${m.params.entry.text}`);
      }
    });
  }

  send(method, params = {}) {
    const msgId = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== msgId) return;
        clearTimeout(timer);
        this.ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
      };
      this.ws.addEventListener('message', onMsg);
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  /** Evaluate an expression that returns a JSON string. */
  async json(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return JSON.parse(res.result.value);
  }

  async goto(url, settleMs = 2400) {
    await this.send('Page.navigate', { url });
    await sleep(settleMs);
  }

  /** Console problems recorded since the last drain. */
  drain() {
    const out = this.problems.filter((p) => !/favicon/i.test(p));
    this.problems.length = 0;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/**
 * @param {object} [opts]
 * @param {number[]} [opts.allowStatuses] HTTP statuses that are the EXPECTED
 *   answer for this step, so the browser logging them is not a failure. The
 *   only legitimate case is an unauthenticated probe: the app has to ask
 *   /api/auth/me to discover that nobody is signed in.
 */
function check(label, result, cdp, { allowStatuses = [] } = {}) {
  const issues = cdp
    .drain()
    .filter((p) => !allowStatuses.some((s) => p.includes(`status of ${s}`)));
  const bad = Object.entries(result).filter(([, v]) => v === false || v === 0);
  const ok = bad.length === 0 && issues.length === 0;

  if (ok) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}`);
    if (bad.length) console.log(`        assertions: ${JSON.stringify(Object.fromEntries(bad))}`);
    issues.forEach((p) => console.log(`        ${p}`));
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const chromePath = findChrome();
if (!chromePath) {
  console.log('\nSkipping end-to-end tests: no Chrome or Edge found.');
  console.log('Set CHROME_PATH to run them.\n');
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('\nThe frontend is not built. Run `npm run build` first.\n');
  process.exit(1);
}

// --- Start an isolated API server -----------------------------------------
const dbFile = path.join(os.tmpdir(), `qrshield-e2e-${Date.now()}.json`);
process.env.NODE_ENV = 'development';
process.env.QRSHIELD_SKIP_DOTENV = '1';
process.env.DB_FILE = dbFile;
// A local file, never the Sanity dataset - the seed wipes what it points at.
process.env.SANITY_PROJECT_ID = '';
process.env.SANITY_DATASET = '';
process.env.SANITY_API_TOKEN = '';
process.env.RATELIMIT_STORE = 'memory';
process.env.SESSION_SECRET = 'e2e-session-secret-not-used-anywhere-real';
process.env.CODE_SECRET = 'e2e-code-secret-not-used-anywhere-real';
process.env.SEED_ADMIN_EMAIL = 'admin@e2e.local';
process.env.SEED_ADMIN_PASSWORD = 'E2ePassword!2026';

console.log('\nSeeding a temporary database...');
const seed = spawn(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: process.env,
});
await new Promise((resolve, reject) =>
  seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))))
);

const { createApp } = await import('../src/server.js');
const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const APP = `http://127.0.0.1:${server.address().port}`;
console.log(`API on ${APP}`);

// --- Launch Chrome ---------------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrshield-chrome-'));
const debugPort = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function cleanup(code) {
  try {
    chrome.kill();
  } catch { /* already gone */ }
  await new Promise((r) => server.close(r));
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${dbFile}${suffix}`, { force: true });
    } catch { /* locked; the OS will clear tmp */ }
  }
  process.exit(code);
}

// Wait for the debugging endpoint to answer.
let target = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch { /* not up yet */ }
  await sleep(250);
}
if (!target) {
  console.error('Chrome did not expose a debugging target.');
  await cleanup(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const cdp = new Cdp(ws);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');

console.log('\nRunning end-to-end tests\n');

try {
  // =========================================================================
  // Public portal
  // =========================================================================
  console.log('Public portal');

  await cdp.goto(`${APP}/`, 2000);
  check(
    'the portal asks who is checking before it offers the check',
    await cdp.json(`JSON.stringify({
      heading: !!document.querySelector('.hero h1'),
      form: !!document.querySelector('.details-form'),
      noCodeInputYet: !document.getElementById('codeInput'),
    })`),
    cdp
  );

  // Fill the form the way a person would - through React's own inputs, so
  // the page's validation and submit path are what is exercised, not a fetch.
  // Setting .value directly bypasses React, hence the native setter + event.
  await cdp.json(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    set('dName', 'Maria Santos');
    set('dPhone', '0917 123 4567');
    set('dEmail', 'maria@gmail.com');
    set('dRole', 'patient');
    set('dCity', 'Quezon City');
    document.getElementById('dConsent').click();
    document.querySelector('.details-form button[type=submit]').click();
    return '"ok"';
  })()`);
  await sleep(1400);
  check(
    'once details are given, the check card appears and says who is checking',
    await cdp.json(`JSON.stringify({
      formGone: !document.querySelector('.details-form'),
      codeInput: !!document.getElementById('codeInput'),
      scanButton: [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Scan the QR code')),
      checkingAs: (document.querySelector('.checker-line')?.textContent ?? '').includes('Checking as Maria Santos'),
    })`),
    cdp
  );

  const sample = await pickCode(APP);

  await cdp.goto(`${APP}/v/${encodeURIComponent(sample.genuine)}`, 2600);
  check(
    'genuine result shows the leaflet and batch detail',
    await cdp.json(`(() => {
      const banner = document.querySelector('.result-banner');
      return JSON.stringify({
        genuine: !!document.querySelector('.banner-genuine'),
        heading: banner?.querySelector('h2')?.textContent === 'Genuine',
        detailRows: document.querySelectorAll('.detail-row').length,
        leafletSections: document.querySelectorAll('.leaflet-section').length,
        reportButton: [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Report a problem')),
      });
    })()`),
    cdp
  );

  await cdp.goto(`${APP}/v/${encodeURIComponent(sample.recalled)}`, 2600);
  check(
    'recalled batch warns and withholds the leaflet',
    await cdp.json(`JSON.stringify({
      flagged: !!document.querySelector('.banner-flagged'),
      noLeaflet: document.querySelectorAll('.leaflet-section').length === 0,
      showsRecallReason: document.body.textContent.includes('Recall reason'),
    })`),
    cdp
  );

  await cdp.goto(`${APP}/v/AMX25-260921-00483-K7`, 2600);
  check(
    'a mistyped code is amber, not a counterfeit warning',
    await cdp.json(`JSON.stringify({
      invalid: !!document.querySelector('.banner-invalid'),
      notFlagged: !document.querySelector('.banner-flagged'),
      mentionsTypo: /mistyped/i.test(document.body.textContent),
    })`),
    cdp
  );

  // =========================================================================
  // Authentication and the dashboard
  // =========================================================================
  console.log('\nDashboard');

  check(
    'the public portal exposes no staff sign-in link',
    await cdp.json(`JSON.stringify({
      noStaffLink: !document.querySelector('a[href="/login"]'),
      noLoginLinkAtAll: document.querySelectorAll('a[href*="login"]').length === 0,
    })`),
    cdp
  );

  await cdp.goto(`${APP}/admin`, 2200);
  check(
    'anonymous visitor is redirected to sign in',
    await cdp.json(`JSON.stringify({ onLogin: location.pathname === '/login' })`),
    cdp,
    // The 401 IS the mechanism: the dashboard asks who is signed in, is told
    // nobody, and redirects.
    { allowStatuses: [401] }
  );

  // Sign in through the actual two-step form, not a bare fetch, so the flow
  // itself is covered.
  await cdp.goto(`${APP}/login`, 2000);
  const setValue = async (sel, val) => `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(val)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify(1);
    })()`;

  await cdp.json(await setValue('#email', 'admin@e2e.local'));
  await cdp.json(`(()=>{document.querySelector('.signin-btn').click();return JSON.stringify(1)})()`);
  await sleep(900);
  check(
    'the email step advances without asking the server (no user enumeration)',
    await cdp.json(`JSON.stringify({
      onPasswordStep: !!document.querySelector('#password'),
      emailCarriedOver: document.querySelector('.signin-identity span')?.textContent === 'admin@e2e.local',
    })`),
    cdp
  );

  await cdp.json(await setValue('#password', 'E2ePassword!2026'));
  await cdp.json(`(()=>{document.querySelector('.signin-btn').click();return JSON.stringify(1)})()`);
  await sleep(2600);
  check(
    'the two-step form signs in and lands on the dashboard',
    await cdp.json(`JSON.stringify({
      onAdmin: location.pathname.startsWith('/admin'),
      shellRendered: !!document.querySelector('.admin-shell'),
    })`),
    cdp
  );

  const SECTIONS = [
    ['', 'Overview'], ['alerts', 'Alerts'], ['scans', 'Scan log'], ['reports', 'Patient reports'], ['customers', 'Customers'],
    ['lookup', 'Code lookup'], ['products', 'Products'], ['batches', 'Batches & codes'],
    ['shipments', 'Shipments'], ['compliance', 'Compliance'], ['audit', 'Audit log'],
    ['users', 'Users'], ['settings', 'Settings'],
  ];

  for (const [section, expectedTitle] of SECTIONS) {
    await cdp.goto(`${APP}/admin/${section}`, 2400);
    check(
      `${expectedTitle} renders`,
      await cdp.json(`(() => {
        const view = document.querySelector('main.view');
        return JSON.stringify({
          title: document.querySelector('.topbar h1')?.textContent === ${JSON.stringify(expectedTitle)},
          hasContent: (view?.children.length ?? 0) > 0,
          notStuckLoading: !view?.querySelector('.spinner'),
          noErrorBanner: !view?.querySelector('.alert-error'),
        });
      })()`),
      cdp
    );
  }

  // =========================================================================
  // Interaction
  // =========================================================================
  console.log('\nInteraction');

  await cdp.goto(`${APP}/admin/alerts`, 2600);
  await cdp.json(`(()=>{document.querySelector('table.data tbody tr').click();return JSON.stringify(1)})()`);
  await sleep(1500);
  check(
    'clicking an alert opens the detail drawer',
    await cdp.json(`(() => {
      const d = document.querySelector('.drawer.open');
      return JSON.stringify({
        open: !!d,
        detail: (d?.querySelectorAll('.kv > div').length ?? 0) > 3,
        noteField: !!d?.querySelector('#alertNote'),
        actions: (d?.querySelectorAll('.drawer-foot button').length ?? 0) >= 2,
      });
    })()`),
    cdp
  );

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(600);
  check(
    'Escape closes the drawer',
    await cdp.json(`JSON.stringify({ closed: !document.querySelector('.drawer.open') })`),
    cdp
  );

  // A person's request under the privacy notice: an administrator can correct
  // or remove their details from the customer drawer. Opened, never sent.
  await cdp.goto(`${APP}/admin/customers`, 2600);
  await cdp.json(`(()=>{document.querySelector('table.data tbody tr').click();return JSON.stringify(1)})()`);
  await sleep(1500);
  const customerButtons = await cdp.json(`(() => {
    const foot = document.querySelector('.drawer.open .drawer-foot');
    const labels = [...(foot?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
    return JSON.stringify({ correct: labels.includes('Correct details'), remove: labels.includes('Remove details') });
  })()`);
  await cdp.json(`(()=>{[...document.querySelectorAll('.drawer.open .drawer-foot button')]
    .find((b) => b.textContent.trim() === 'Remove details')?.click();return JSON.stringify(1)})()`);
  await sleep(1200);
  check(
    'an administrator can correct or remove a customer, with a warning and a reason',
    {
      ...customerButtons,
      ...(await cdp.json(`JSON.stringify({
        warned: /cannot be undone/i.test(document.querySelector('.drawer.open')?.textContent ?? ''),
        reasonBox: !!document.querySelector('.drawer.open #rReason'),
      })`)),
    },
    cdp
  );
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(600);

  // Regression: the account panel used to render its own overlay inside the
  // sidebar. `position: sticky` there creates a stacking context, so the
  // page's sticky table headers painted straight through the panel. It now
  // goes through the shared drawer, which renders outside the sidebar.
  await cdp.goto(`${APP}/admin/compliance`, 2600);
  await cdp.json(`(()=>{document.querySelector('.user-chip').click();return JSON.stringify(1)})()`);
  await sleep(1800);
  check(
    'the account panel paints above the page, with its header intact',
    await cdp.json(`(() => {
      const d = document.querySelector('.drawer.open');
      if (!d) return JSON.stringify({ opened: false });
      const b = d.getBoundingClientRect();
      const topmost = (f) => {
        const el = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height * f));
        return !!el && !!el.closest('.drawer');
      };
      return JSON.stringify({
        opened: true,
        onlyOneDrawerInDom: document.querySelectorAll('.drawer').length === 1,
        renderedOutsideSidebar: !d.closest('.sidebar'),
        headerVisible: !!d.querySelector('.drawer-head h2')?.textContent,
        closeButton: !!d.querySelector('.drawer-head .icon-btn'),
        nothingBleedsThrough: topmost(0.15) && topmost(0.4) && topmost(0.85),
      });
    })()`),
    cdp
  );

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(600);

  // The top bar clock and the picture beside it. The clock is asserted on
  // shape rather than value - the test cannot know the machine's locale, but a
  // clock stuck on a placeholder, or one line silently missing, would show up
  // here. The picture opens the same account panel as the sidebar chip.
  check(
    'the top bar shows a clock and opens the account panel from the picture',
    await cdp.json(`(async () => {
      const clock = document.querySelector('.topbar .shell-clock');
      const before = !!document.querySelector('.drawer.open');
      document.querySelector('.topbar .shell-avatar').click();
      await new Promise((r) => setTimeout(r, 1500));
      return JSON.stringify({
        hasTime: /[0-9]{1,2}[:.][0-9]{2}/.test(clock?.querySelector('strong')?.textContent ?? ''),
        hasDate: (clock?.querySelector('span')?.textContent ?? '').length > 8,
        machineReadable: !Number.isNaN(Date.parse(clock?.getAttribute('datetime') ?? '')),
        noDrawerBefore: !before,
        pictureOpensAccount: !!document.querySelector('.drawer.open .drawer-head h2')?.textContent,
      });
    })()`, true),
    cdp
  );

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(600);

  await cdp.goto(`${APP}/admin/batches`, 2600);
  await cdp.json(`(()=>{document.querySelector('table.data tbody tr').click();return JSON.stringify(1)})()`);
  await sleep(1600);
  await cdp.json(
    `(()=>{[...document.querySelectorAll('.drawer button')]
        .find(b=>b.textContent.includes('Print labels'))?.click();return JSON.stringify(1)})()`
  );
  await sleep(2200);
  check(
    'the label sheet renders real QR images',
    await cdp.json(`(() => {
      const d = document.querySelector('.drawer.open');
      return JSON.stringify({
        cells: d?.querySelectorAll('.label-cell').length ?? 0,
        svgs: d?.querySelectorAll('.label-cell svg').length ?? 0,
        codeText: !!d?.querySelector('.label-cell .lc')?.textContent?.trim(),
      });
    })()`),
    cdp
  );

  // =========================================================================
  // Role-based access, as the browser sees it
  // =========================================================================
  console.log('\nRole-based access');

  // Navigate away from the dashboard first, so its badge pollers unmount
  // before the session changes underneath them.
  await cdp.goto(`${APP}/`, 1200);
  await cdp.json(`fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':
     (document.cookie.match(/qrs_csrf=([^;]+)/)||[])[1] ?? ''}}).then(r=>JSON.stringify(r.status))`, true);
  await cdp.json(
    `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({email:'regulator@qrshield.example',password:'Regulator!2026'})})
       .then(r=>JSON.stringify(r.status))`,
    true
  );

  await cdp.goto(`${APP}/admin`, 2600);
  check(
    'a regulator sees a reduced navigation',
    await cdp.json(`(() => {
      const nav = [...document.querySelectorAll('.nav a')].map(a=>a.textContent);
      return JSON.stringify({
        fewerItems: nav.length > 0 && nav.length <= 7,
        noScanLog: !nav.some(t=>t.includes('Scan log')),
        noUsers: !nav.some(t=>t.includes('Users')),
        hasCompliance: nav.some(t=>t.includes('Compliance')),
      });
    })()`),
    cdp
  );

  await cdp.goto(`${APP}/admin/scans`, 2400);
  check(
    'a regulator typing /admin/scans is refused',
    await cdp.json(`JSON.stringify({
      denied: /does not have access/i.test(document.querySelector('main.view')?.textContent ?? ''),
      noTable: !document.querySelector('table.data'),
    })`),
    cdp
  );

  // =========================================================================
  // Responsive
  // =========================================================================
  console.log('\nResponsive');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  await cdp.goto(`${APP}/`, 2200);
  check(
    'the portal has no horizontal overflow on a phone',
    await cdp.json(`JSON.stringify({
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    })`),
    cdp
  );

  await cdp.goto(`${APP}/admin`, 2600);
  const before = await cdp.json(
    `JSON.stringify({ hidden: !document.querySelector('.sidebar').classList.contains('open') })`
  );
  await cdp.json(`(()=>{document.querySelector('.menu-btn').click();return JSON.stringify(1)})()`);
  await sleep(600);
  const after = await cdp.json(
    `JSON.stringify({ opened: document.querySelector('.sidebar').classList.contains('open') })`
  );
  check('the sidebar collapses and opens on tap', { ...before, ...after }, cdp);
} catch (err) {
  failed += 1;
  console.error(`\n  \x1b[31mERROR\x1b[0m ${err.message}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
await cleanup(failed === 0 ? 0 : 1);

/** Pull usable sample codes out of the freshly seeded database. */
async function pickCode(base) {
  const db = await import('../src/db/index.js');
  db.open();
  const today = new Date().toISOString().slice(0, 10);
  const live = await db.findMany('batch', { status: 'distributed', is_test: 0, expiry_date: { gt: today } }, { fields: ['id'] });
  const genuine = (await db.findOne('code', { scan_count: 0, batch_id: { in: live.map((b) => b.id) } })).code;
  const recalledBatch = await db.findOne('batch', { status: 'recalled' });
  const recalled = (await db.findOne('code', { batch_id: recalledBatch.id })).code;
  return { genuine, recalled, base };
}
