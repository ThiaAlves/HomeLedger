<script lang="ts">
import { activeTheme } from '$lib/stores/theme';
import { formatLocalDate } from '$lib/utils/local-date';
import { onMount, tick } from 'svelte';
import CardReconcile from '$lib/components/CardReconcile.svelte';
import CardBillTools from '$lib/components/CardBillTools.svelte';
import { firstCardDue } from '$lib/utils/card-dates';
import { apiGet, apiPost, apiPatch } from '$lib/api/client';
import { t } from '$lib/i18n';
import { preferences } from '$lib/stores/preferences';
import { getIntlTag } from '$lib/i18n/registry';
import type { TranslationKey } from '$lib/i18n/es';
type Account = {
  id: number;
  name: string;
  type: string;
  currency: string;
  statementDay?: number;
  paymentDueDay?: number;
};
type Category = { id: number; name: string; type: string };
type Due = {
  id: number;
  commitment_id: number;
  name: string;
  kind: string;
  number: number;
  due_date: string;
  amount_cents: number;
  paid_cents: number;
  cancelled: number;
  total_installments: number;
  account_id: number;
};
type Bill = {
  id: number;
  account_id: number;
  account_name: string;
  due_date: string;
  total_cents: number;
  paid_cents: number;
  closed: number;
};
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let subscriptions = $state<{ id: number; name: string; cycle: string; status: string }[]>([]),
  subscription = $state('');
let contractView = $state<{
  id: number;
  name: string;
  details: string;
  events: {
    id: number;
    date: string;
    kind: string;
    notes: string;
    amount_cents: number;
    outstanding_cents: number | null;
  }[];
} | null>(null);
let eventKey = $state('');
let eventKind = $state('balance'),
  eventDate = $state(localToday()),
  eventAmount = $state<number | undefined>(),
  outstanding = $state<number | undefined>(),
  eventNotes = $state(''),
  recordExpense = $state(false);
let dues = $state<Due[]>([]),
  bills = $state<Bill[]>([]),
  accounts = $state<Account[]>([]),
  categories = $state<Category[]>([]);
let month = $state(localToday().slice(0, 7)),
  loading = $state(true),
  busy = $state(false),
  error = $state(''),
  notice = $state('');
let kind = $state('once'),
  name = $state(''),
  amount = $state<number | undefined>(),
  count = $state(1),
  first = $state(1),
  due = $state(localToday()),
  date = $state(localToday()),
  account = $state(''),
  category = $state(''),
  institution = $state(''),
  contract = $state(''),
  notes = $state('');
let payment = $state<{ id: number; bill: boolean; remaining: number } | null>(null),
  payAmount = $state<number | undefined>(),
  payDate = $state(localToday()),
  source = $state(''),
  paymentKey = $state('');
let editing = $state<Due | null>(null),
  editAmount = $state<number | undefined>(),
  future = $state(false);
const visible = $derived(dues.filter((d) => d.due_date.startsWith(month)));
const visibleBills = $derived(bills.filter((d) => d.due_date.startsWith(month)));
const cents = $derived(Math.round((amount ?? 0) * 100));
const validCount = $derived(Math.min(600, Math.max(1, count || 1)));
const preview = $derived(
  Array.from({ length: kind === 'once' ? 1 : Math.min(6, validCount - first + 1) }, (_, i) => {
    const n = first + i;
    return {
      n,
      amount:
        kind === 'installment' || kind === 'card'
          ? Math.floor(cents / validCount) + (n - 1 < cents % validCount ? 1 : 0)
          : cents,
    };
  }),
);
const monthlyTotals = $derived.by(() => {
  const result: Record<string, { planned: number; paid: number; remaining: number }> = {};
  for (const row of [
    ...visible
      .filter((d) => !d.cancelled)
      .map((d) => ({ account: d.account_id, total: d.amount_cents, paid: d.paid_cents })),
    ...visibleBills.map((b) => ({
      account: b.account_id,
      total: b.total_cents,
      paid: b.paid_cents,
    })),
  ]) {
    const currency = accounts.find((a) => a.id === row.account)?.currency ?? 'BRL';
    const total = result[currency] ?? { planned: 0, paid: 0, remaining: 0 };
    total.planned += row.total;
    total.paid += row.paid;
    total.remaining += Math.max(0, row.total - row.paid);
    result[currency] = total;
  }
  return result;
});
const currencyMoney = (c: number, currency: string) =>
  new Intl.NumberFormat(getIntlTag($preferences.locale), { style: 'currency', currency }).format(
    c / 100,
  );
const money = (c: number, a?: number) =>
  new Intl.NumberFormat(getIntlTag($preferences.locale), {
    style: 'currency',
    currency: accounts.find((x) => x.id === a)?.currency ?? 'BRL',
  }).format(c / 100);
const label = (key: string) => $t(('payables.' + key) as TranslationKey);
const remaining = (d: Due) => (d.cancelled ? 0 : d.amount_cents - d.paid_cents);
function status(d: Due) {
  return d.cancelled
    ? 'cancelled'
    : remaining(d) === 0
      ? 'paid'
      : d.due_date < localToday()
        ? 'late'
        : d.paid_cents
          ? 'partial'
          : 'open';
}
async function load() {
  loading = true;
  try {
    [dues, bills, accounts, categories, subscriptions] = await Promise.all([
      apiGet<Due[]>('/payables'),
      apiGet<Bill[]>('/payables/bills'),
      apiGet<Account[]>('/accounts'),
      apiGet<Category[]>('/categories'),
      apiGet<typeof subscriptions>('/subscriptions'),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
  }
}
onMount(() => {
  void load();
});
async function action(fn: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  error = '';
  notice = '';
  try {
    await fn();
    await load();
    window.dispatchEvent(new CustomEvent('homeledger:data-changed'));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
  }
}
let purchaseKey='', purchasePayload='';
async function create(event: SubmitEvent) {
  event.preventDefault();
  await action(async () => {
    if (kind === 'card') {
      const payload={name,accountId:Number(account),categoryId:Number(category),amountCents:cents,installments:validCount,firstNumber:first,date,firstDue:due};
      const fingerprint=JSON.stringify(payload);if(fingerprint!==purchasePayload){purchaseKey=crypto.randomUUID();purchasePayload=fingerprint;}
      await apiPost('/payables/purchases',{...payload,key:purchaseKey});purchasePayload='';purchaseKey='';
    }
    else
      await apiPost('/payables', {
        name,
        kind,
        accountId: Number(account),
        categoryId: Number(category),
        amountCents: cents,
        installments: kind === 'once' ? 1 : validCount,
        firstNumber: kind === 'once' || kind === 'recurring' ? 1 : first,
        firstDue: due,
        details: { institution, contract, notes },
      });
    name = '';
    amount = undefined;
  });
}
function openPay(id: number, bill: boolean, balance: number) {
  payment = { id, bill, remaining: balance };
  payAmount = balance / 100;
  payDate = localToday();
  paymentKey = crypto.randomUUID();
  void tick().then(() => {
    document.getElementById('payable-payment')?.scrollIntoView?.({ behavior: 'smooth' });
    document.querySelector<HTMLInputElement>('#payable-payment input')?.focus();
  });
}
async function pay(event: SubmitEvent) {
  event.preventDefault();
  const p = payment;
  if (!p) return;
  await action(async () => {
    await apiPost(`/payables/${p.bill ? 'bills/' : ''}${p.id}/pay`, {
      amountCents: Math.round((payAmount ?? 0) * 100),
      date: payDate,
      key: paymentKey,
      ...(p.bill ? { sourceAccountId: Number(source) } : {}),
    });
    payment = null;
    notice = label('recorded');
  });
}
function suggestDue() {
  const a = accounts.find((a) => a.id === Number(account));
  if (kind === 'card' && a?.statementDay && a.paymentDueDay)
    due = firstCardDue(date, a.statementDay, a.paymentDueDay);
}
async function showContract(id: number) {
  await action(async () => {
    contractView = await apiGet(`/payables/commitments/${id}`);
    eventKey = crypto.randomUUID();
  });
}
async function saveEvent(e: SubmitEvent) {
  e.preventDefault();
  const c = contractView;
  if (!c) return;
  await action(async () => {
    await apiPost(`/payables/commitments/${c.id}/events`, {
      key: eventKey,
      kind: eventKind,
      date: eventDate,
      amountCents: Math.round((eventAmount ?? 0) * 100),
      ...(outstanding === undefined ? {} : { outstandingCents: Math.round(outstanding * 100) }),
      notes: eventNotes,
      recordExpense,
    });
    contractView = await apiGet(`/payables/commitments/${c.id}`);
    eventAmount = undefined;
    eventNotes = '';
    eventKey = crypto.randomUUID();
  });
}

</script>
<svelte:head><title>{$t('payables.title')} · HomeLedger</title></svelte:head>

<div class="payables">

{#if !$activeTheme.workspace}
<h1>{$t('payables.title')}</h1>
<p>{$t('payables.description')}</p>
{/if}

{#if error}
<p role="alert" class="error">{error}
<button onclick={load} disabled={busy}>{$t('payables.retry')}</button></p>
{/if}

{#if notice}
<p role="status">{notice}</p>
{/if}

<details class="panel"><summary>{$t('payables.add')}</summary>

<form onsubmit={create} class="form">

<label>{$t('payables.kind')}<select bind:value={kind} onchange={()=>{account='';first=1;}}>
{#each ['once','recurring','installment','consortium','housing','card'] as k}<option value={k}>{label(k)}</option>
{/each}</select>
</label>

<label>{$t('payables.name')}<input required maxlength="100" bind:value={name}/>
</label>

<label>{label(kind==='installment'||kind==='card'?'total':'amount')}<input required type="number" min="0.01" max="999999999.99" step="0.01" bind:value={amount}/>
</label>

{#if !['once','recurring'].includes(kind)}
<label>{$t('payables.count')}<input required type="number" min="1" max="600" bind:value={count}/>
</label>
{/if}

{#if ['installment','consortium','housing','card'].includes(kind)}
<label>{$t('payables.first')}<input required type="number" min="1" max={count} bind:value={first}/>
</label>
{/if}

<label>{label(kind==='card'?'first_bill':'due')}<input required type="date" bind:value={due}/>
</label>

{#if kind==='card'}
<label>{$t('payables.purchase_date')}<input required type="date" max={due} bind:value={date} onchange={suggestDue}/>
</label>
{/if}

<label>{$t('payables.account')}<select required bind:value={account} onchange={suggestDue}><option value="">{$t('payables.select')}</option>
{#each accounts.filter(a=>kind==='card'?a.type==='Crédito':a.type!=='Crédito') as a}<option value={a.id}>{a.name} ({a.currency})</option>
{/each}</select>
</label>

<label>{$t('payables.category')}<select required bind:value={category}><option value="">{$t('payables.select')}</option>
{#each categories.filter(c=>c.type!=='Ingreso') as c}<option value={c.id}>{c.name}</option>
{/each}</select>
</label>

{#if ['consortium','housing'].includes(kind)}
<p class="wide">{$t('payables.contract_hint')}</p>
<label>{$t('payables.institution')}<input maxlength="100" bind:value={institution}/>
</label>
<label>{$t('payables.contract')}<input maxlength="100" bind:value={contract}/>
</label>
<label class="wide">{$t('payables.notes')}<textarea maxlength="2000" bind:value={notes}></textarea>
</label>
{/if}

{#if kind==='card'}
<p class="wide">{$t('payables.card_hint')}</p>
{/if}

{#if kind==='recurring'}
<p class="wide">{$t('payables.recurring_hint')}</p>
{/if}

<div class="wide"><strong>{$t('payables.preview')}</strong>
<div class="preview">
{#each preview as p}<span>{p.n}/{kind==='recurring'?'∞':kind==='once'?1:validCount}: {money(p.amount,Number(account))}</span>
{/each}
</div>
</div>

<button disabled={busy}>{$t('payables.save')}</button>

</form>
</details>

<details class="panel"><summary>{$t('payables.convert')}</summary>
<p>{$t('payables.convert_hint')}</p>
<form class="form" onsubmit={e=>{e.preventDefault();void action(()=>apiPost(`/payables/subscriptions/${subscription}/convert`,{}));}}>
<label>{$t('nav.subscriptions')}<select required bind:value={subscription}><option value="">{$t('payables.select')}</option>
{#each subscriptions.filter(s=>s.cycle==='Mensual'&&s.status==='Activa') as sub}<option value={sub.id}>{sub.name}</option>
{/each}</select>
</label>
<button disabled={busy}>{$t('payables.convert')}</button>
</form>
</details>

<label class="month">{$t('payables.month')}<input type="month" bind:value={month}/>
</label>

<div class="preview">
{#each Object.entries(monthlyTotals) as [currency,totals]}
<div class="panel"><b>{currency}</b>
<p>{$t('payables.planned')}: {currencyMoney(totals.planned,currency)}</p>
<p>{$t('payables.paid')}: {currencyMoney(totals.paid,currency)}</p>
<p>{$t('payables.remaining')}: {currencyMoney(totals.remaining,currency)}</p>
</div>
{/each}
</div>

{#if loading}
<p role="status">{$t('payables.loading')}</p>
{/if}

<div class="grid">
{#each visible as d}
<article class="panel" class:overdue={status(d)==='late'}>
<header><strong>{d.name}</strong><span>{label(status(d))}</span>
</header>
<p>{formatLocalDate(d.due_date,getIntlTag($preferences.locale))} · {d.number}/{d.kind==='recurring'?'∞':d.total_installments}</p>
<p>{money(d.amount_cents,d.account_id)} · {$t('payables.remaining')}: <b>{money(remaining(d),d.account_id)}</b></p>

{#if ['housing','consortium'].includes(d.kind)}
<button disabled={busy} onclick={()=>showContract(d.commitment_id)}>{$t('payables.contract_details')}</button>
{/if}

{#if remaining(d)>0}
<div class="actions">
<button disabled={busy} onclick={()=>openPay(d.id,false,remaining(d))}>{$t('payables.pay')}</button>
{#if !d.paid_cents}
<button disabled={busy} onclick={()=>{editing=d;editAmount=d.amount_cents/100;future=false;}}>{$t('payables.edit')}</button>
<button disabled={busy} onclick={()=>{if(confirm(label('confirm_cancel')))void action(()=>apiPost(`/payables/${d.id}/cancel`,{}));}}>{$t('payables.cancel')}</button>
{/if}
<button disabled={busy} onclick={()=>{if(confirm(label('confirm_stop')))void action(()=>apiPost(`/payables/commitments/${d.commitment_id}/stop`,{}));}}>{$t('payables.stop')}</button>
</div>
{/if}

</article>
{:else}
<p>{$t('payables.empty')}</p>
{/each}
</div>

<h2>{$t('payables.bills')}</h2>
<CardReconcile {accounts} {busy} refreshed={load} />
<div class="grid">
{#each visibleBills as b (b.id)}
<article class="panel">
<header><strong>{b.account_name}</strong><span>{label(b.closed?'closed':'open')}</span>
</header>
<p>{formatLocalDate(b.due_date,getIntlTag($preferences.locale))} · {money(b.total_cents,b.account_id)}</p>
<p>{label(b.total_cents<b.paid_cents?'credit':'remaining')}: <b>{money(Math.abs(b.total_cents-b.paid_cents),b.account_id)}</b></p>
<div class="actions">

{#if !b.closed}
<button disabled={busy} onclick={()=>action(()=>apiPost(`/payables/bills/${b.id}/close`,{}))}>{$t('payables.close')}</button>
{/if}
{#if b.total_cents>b.paid_cents}
<button disabled={busy} onclick={()=>openPay(b.id,true,b.total_cents-b.paid_cents)}>{$t('payables.pay')}</button>
{/if}
</div>
<CardBillTools bill={b} {busy} refreshed={load} />

</article>
{:else}
<p>{$t('payables.empty')}</p>
{/each}
</div>

{#if contractView}
<section class="panel">
<header>
<h2>{contractView.name}</h2>
<button onclick={()=>contractView=null}>{$t('common.close')}</button>
</header>
<p>{JSON.parse(contractView.details).institution} · {JSON.parse(contractView.details).contract}</p>
<p>{JSON.parse(contractView.details).notes}</p>
{#if JSON.parse(contractView.details).outstandingCents!==undefined}
<p>{$t('payables.outstanding')}: {money(JSON.parse(contractView.details).outstandingCents)} ({JSON.parse(contractView.details).referenceDate})</p>
{/if}
<h3>{$t('payables.event')}</h3>
<form class="form" onsubmit={saveEvent}>
<label>{$t('payables.kind')}<select bind:value={eventKind}>
{#each ['balance','amortization','bid','contemplation','adjustment'] as k}<option value={k}>{label(k)}</option>
{/each}</select>
</label>
<label>{$t('payables.date')}<input required type="date" bind:value={eventDate}/>
</label>
<label>{$t('payables.amount')}<input type="number" min="0" step="0.01" bind:value={eventAmount}/>
</label>
<label>{$t('payables.outstanding')}<input type="number" min="0" step="0.01" bind:value={outstanding}/>
</label>
<label class="wide">{$t('payables.notes')}<textarea maxlength="2000" bind:value={eventNotes}></textarea>
</label>
<label class="wide"><input type="checkbox" bind:checked={recordExpense}/>{$t('payables.record_expense')}
</label>
<button disabled={busy}>{$t('payables.save')}</button>
</form><ul>
{#each contractView.events as ev}<li>{formatLocalDate(ev.date,getIntlTag($preferences.locale))} · {label(ev.kind)} · {money(ev.amount_cents)} · {ev.notes}
{#if ev.outstanding_cents!==null} · {$t('payables.outstanding')}: {money(ev.outstanding_cents)}
{/if}</li>
{/each}</ul>
</section>
{/if}

{#if payment}
<section id="payable-payment" class="panel" aria-label={$t('payables.pay')}>
<h2>{$t('payables.pay')}</h2>
<form class="form" onsubmit={pay}>
<label>{$t('payables.amount')}<input required type="number" min="0.01" max={payment.remaining/100} step="0.01" bind:value={payAmount}/>
</label>
<label>{$t('payables.date')}<input required type="date" bind:value={payDate}/>
</label>
{#if payment.bill}
<label>{$t('payables.account')}<select required bind:value={source}><option value="">{$t('payables.select')}</option>
{#each accounts.filter(a=>a.type!=='Crédito') as a}<option value={a.id}>{a.name}</option>
{/each}</select>
</label>
{/if}
<button disabled={busy}>{$t('payables.pay')}</button>
<button type="button" disabled={busy} onclick={()=>payment=null}>{$t('common.close')}</button>
</form>
</section>
{/if}

{#if editing}
<section class="panel">
<h2>{$t('payables.edit')}</h2>
<form class="form" onsubmit={e=>{e.preventDefault();const row=editing;if(row)void action(async()=>{await apiPatch(`/payables/${row.id}`,{amountCents:Math.round((editAmount??0)*100),scope:future?'future':'one'});editing=null;});}}>
<label>{$t('payables.amount')}<input required type="number" min="0.01" step="0.01" bind:value={editAmount}/>
</label>
<label><input type="checkbox" bind:checked={future}/>{$t('payables.future')}
</label>
<button disabled={busy}>{$t('payables.save')}</button>
<button type="button" disabled={busy} onclick={()=>editing=null}>{$t('common.close')}</button>
</form>
</section>
{/if}

</div>
<style>
.payables {
  max-width: 1200px;
  margin: auto;
  padding: 1rem;
  color: var(--text-primary);
}
p {
  color: var(--text-secondary);
  line-height: 1.5;
}
.panel {
  border: 1px solid var(--border-color, #5555);
  border-radius: 12px;
  padding: 1rem;
  margin: 1rem 0;
  background: var(--bg-card, var(--bg-secondary));
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
input,
select,
textarea,
button {
  font: inherit;
  color: inherit;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color, #7777);
  border-radius: 6px;
  padding: 0.65rem;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.wide {
  grid-column: 1/-1;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 1rem;
}
.grid .panel {
  margin: 0;
}
.actions,
.preview {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.month {
  max-width: 240px;
  margin: 1rem 0;
}
.error {
  color: var(--accent-red, #d55);
}
.overdue {
  border-color: var(--accent-red, #d55);
}
</style>
