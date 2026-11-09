import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'homeledger-card-qa-'));
const password = randomBytes(24).toString('hex');
const portServer = net.createServer();
await new Promise((r) => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const base = `http://127.0.0.1:${port}`;
const backend = spawn(
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'packages/backend/src/server.ts'],
  {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: join(dir, 'data'),
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      JWT_SECRET: randomBytes(48).toString('hex'),
      ADMIN_EMAIL: 'qa-card@example.test',
      ADMIN_PASSWORD: password,
      DEFAULT_LOCALE: 'pt-BR',
      CURRENCY: 'BRL',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLog = '';
backend.stdout.on('data', (b) => (serverLog += b));
backend.stderr.on('data', (b) => (serverLog += b));
let chrome, ws;
const pending = new Map();
let sequence = 0;
const browserErrors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 160; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await wait(150);
  }
  throw Error(`Timeout: ${label}`);
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
let token;
async function api(path, body) {
  const response = await fetch(base + '/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(`${path}: ${JSON.stringify(data)}`);
  return data.data ?? data;
}
async function click(text) {
  await until(()=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`),'button: '+text);
}

try {
  await until(async () => {
    const r = await fetch(base + '/api/v1/health');
    return r.ok;
  }, 'backend');
  token = (await api('/auth/login', { email: 'qa-card@example.test', password })).accessToken;
  const bank = await api('/accounts', {
    name: 'Banco QA',
    type: 'Débito',
    initialBalance: 10000,
    currency: 'BRL',
  });
  const card = await api('/accounts', {
    name: 'Cartão QA',
    type: 'Crédito',
    initialBalance: 0,
    currency: 'BRL',
    creditLimit: 10000,
    statementDay: 5,
    paymentDueDay: 15,
  });
  const category = (await api('/categories')).find((c) => c.type !== 'Ingreso');
  const d = new Date();
  const current = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 15);
  const next = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-15`;
  await api('/payables/purchases', {
    name: 'Celular QA',
    accountId: card.id,
    categoryId: category.id,
    amountCents: 30000,
    installments: 3,
    firstNumber: 1,
    date: current.slice(0, 8) + '01',
    firstDue: current,
    key: randomUUID(),
  });
  for (const [name, amount, day] of [
    ['Aluguel', 150000, '05'],
    ['Internet', 12000, '10'],
    ['Energia', 24000, '12'],
    ['Consórcio', 85000, '20'],
  ])
    await api('/payables', {
      name,
      kind: 'recurring',
      direction: 'expense',
      accountId: bank.id,
      categoryId: category.id,
      amountCents: amount,
      firstDue: current.slice(0, 8) + day,
    });
  const incomeCategory = (await api('/categories')).find((c) => c.type === 'Ingreso');
  chrome = spawn(
    process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(dir, 'chrome')}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const devtools = await until(
    async () => await readFile(join(dir, 'chrome', 'DevToolsActivePort'), 'utf8'),
    'chrome',
  );
  const chromePort = devtools.split('\n')[0];
  const target = await (
    await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      }
    } else if (m.method === 'Runtime.exceptionThrown')
      browserErrors.push(
        m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
      );
    else if (m.method === 'Page.javascriptDialogOpening')
      void send('Page.handleJavaScriptDialog', { accept: true });
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `sessionStorage.setItem('sf_access_token',${JSON.stringify(token)});localStorage.setItem('sf_preferences',JSON.stringify({locale:'pt-BR',currency:'BRL'}));if(!localStorage.getItem('sf_ui_skin'))localStorage.setItem('sf_ui_skin','normal');localStorage.setItem('sf_theme','dark');`,
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: base + '/contas-a-pagar' });
  await until(
    () =>
      evaluate(
        `document.querySelector('.payables-page')&&document.body.innerText.includes('Aluguel')&&!document.body.innerText.includes('Carregando…')`,
      ),
    'card page',
  );
  await click('Nova receita');
  await evaluate(
    `(()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [id,value]of [['pay-name','Salário QA'],['pay-amount','5000'],['pay-due',${JSON.stringify(current.slice(0, 8) + '05')}]]){const el=document.getElementById(id);set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}for(const [id,value]of [['pay-account',${JSON.stringify(String(bank.id))}],['pay-category',${JSON.stringify(String(incomeCategory.id))}]]){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));}document.getElementById('pay-direction').closest('form').requestSubmit();})()`,
  );
  await until(async () => {
    const rows = await api('/payables');
    return rows.some((r) => r.name === 'Salário QA' && r.direction === 'income');
  }, 'salary created in browser');
  await until(
    () => evaluate(`!document.querySelector('details.form-accordion[open]')`),
    'income form saved',
  );
  await click('Registrar recebimento');
  await evaluate(`document.querySelector('#payable-payment form').requestSubmit()`);
  await until(async () => {
    const rows = await api('/accounts');
    return rows.find((a) => a.id === bank.id)?.calculatedBalance === 15000;
  }, 'salary credited after confirmation');
  await evaluate(`document.getElementById('tab-bills').click()`);
  await click('Compras e histórico');
  await until(() => evaluate(`document.body.innerText.includes('Celular QA')`), 'purchase details');
  await click('Estornar compra');
  await evaluate(
    `(()=>{const form=document.querySelector('form[aria-label="Estornar compra"]');const inputs=form.querySelectorAll('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inputs[0],'50');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));set.call(inputs[1],${JSON.stringify(next)});inputs[1].dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();})()`,
  );
  await until(async () => {
    const rows = await api('/payables/bills');
    const future = rows.find((b) => b.due_date === next);
    return future?.total_cents === 5000;
  }, 'refund posted');
  await until(
    () => evaluate(`!document.querySelector('form[aria-label="Estornar compra"]')`),
    'refund form complete',
  );
  await click('Registrar pagamento');
  await evaluate(
    `(()=>{const form=document.querySelector('#payable-payment form');const select=form.querySelector('select');select.value=${JSON.stringify(String(bank.id))};select.dispatchEvent(new Event('change',{bubbles:true}));form.requestSubmit();})()`,
  );
  await until(async () => {
    const rows = await api('/payables/bills');
    return rows.find((b) => b.due_date === current)?.paid_cents === 10000;
  }, 'payment posted');
  await until(
    () => evaluate(`document.body.innerText.includes('Desfazer pagamento')`),
    'history refreshed',
  );
  await click('Desfazer pagamento');
  await until(async () => {
    const rows = await api('/payables/bills');
    return rows.find((b) => b.due_date === current)?.paid_cents === 0;
  }, 'payment reversed');
  await evaluate(`document.getElementById('tab-commitments').click();window.scrollTo(0,0)`);
  await wait(350);
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(dir, 'normal-desktop.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`localStorage.setItem('sf_ui_skin','cyberpunk')`);
  await send('Page.reload');
  await until(
    () =>
      evaluate(
        `document.querySelector('.cp-workspace')&&document.querySelector('.payables-page')&&document.body.innerText.includes('Aluguel')`,
      ),
    'cyberpunk card page',
  );
  await wait(300);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(dir, 'cyberpunk-desktop.png'), Buffer.from(shot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait(200);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(dir, 'cyberpunk-mobile.png'), Buffer.from(shot.data, 'base64'));
  const overflow = await evaluate(`document.documentElement.scrollWidth>window.innerWidth+2`);
  if (browserErrors.length) throw Error(`Browser errors: ${browserErrors.join(';')}`);
  if (overflow) throw Error('Mobile horizontal overflow');
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'monthly salary creation and receipt',
        'real browser refund',
        'real browser payment',
        'real browser undo payment',
        'both themes',
        '390px mobile without overflow',
      ],
      screenshots: dir,
    }),
  );
} catch (e) {
  console.error(e.message);
  if(ws){try{const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,'failure.png'),Buffer.from(shot.data,'base64'));await writeFile(join(dir,'failure.txt'),await evaluate('document.body.innerText'));console.error('Failure artifacts: '+dir);}catch{}}
  if (!token) console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome?.kill('SIGTERM');
  backend.kill('SIGTERM');
}
