<script lang="ts">
import { formatLocalDate } from '$lib/utils/local-date';
import { onMount, tick } from 'svelte';
import CardReconcile from '$lib/components/CardReconcile.svelte';
import CardBillTools from '$lib/components/CardBillTools.svelte';
import { firstCardDue } from '$lib/utils/card-dates';
import { apiGet, apiPost, apiPatch } from '$lib/api/client';
import { t } from '$lib/i18n';
import { preferences } from '$lib/stores/preferences';
import { getIntlTag } from '$lib/i18n/registry';
import { modalPanel, scrim } from '$lib/motion';
import Icon from '$lib/components/Icon.svelte';
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
  direction?: 'income' | 'expense';
  number: number;
  due_date: string;
  amount_cents: number;
  paid_cents: number;
  cancelled: number;
  total_installments: number;
  account_id: number;
  category_id: number;
  account_name?: string;
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

let subscriptions = $state<{ id: number; name: string; cycle: string; status: string }[]>([]);
let subscription = $state('');

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
let eventKind = $state('balance');
let eventDate = $state(localToday());
let eventAmount = $state<number | undefined>();
let outstanding = $state<number | undefined>();
let eventNotes = $state('');
let recordExpense = $state(false);

let dues = $state<Due[]>([]);
let bills = $state<Bill[]>([]);
let accounts = $state<Account[]>([]);
let categories = $state<Category[]>([]);

let month = $state(localToday().slice(0, 7));
let loading = $state(true);
let busy = $state(false);
let error = $state('');
let notice = $state('');

// UI tabs and filters
let activeTab = $state<'commitments' | 'income' | 'bills'>('commitments');
let statusFilter = $state<'all' | 'open' | 'paid' | 'late' | 'cancelled'>('open');
let showCreateCard = $state(false);
let showConvertModal = $state(false);

let search=$state('');
let accountFilter=$state('');
let sortBy=$state<'urgency'|'date'|'amount'>('urgency');
let direction=$state<'expense'|'income'>('expense');

// Form state
let kind = $state('once');
let name = $state('');
let amount = $state<number | undefined>();
let count = $state(1);
let first = $state(1);
let due = $state(localToday());
let date = $state(localToday());
let account = $state('');
let category = $state('');
let institution = $state('');
let contract = $state('');
let notes = $state('');

// Payment Modal State
let payment = $state<{ id: number; bill: boolean; remaining: number; name?: string; income?: boolean } | null>(null);
let payAmount = $state<number | undefined>();
let payDate = $state(localToday());
let source = $state('');
let paymentKey = $state('');

// Edit Modal State
let editing = $state<Due | null>(null);
let editAmount = $state<number | undefined>();
let future = $state(false);

const visible = $derived(dues.filter((d) => d.due_date.startsWith(month)));
const visibleBills = $derived(bills.filter((d) => d.due_date.startsWith(month)));

const expenses=$derived(visible.filter(d=>d.direction!=='income'));
const incomes=$derived(visible.filter(d=>d.direction==='income'));
const scopedDues=$derived(activeTab==='income'?incomes:expenses);
const statusMatches=(d:Due)=>statusFilter==='all'||(statusFilter==='open'?remaining(d)>0&&!d.cancelled:status(d)===statusFilter);
const searchMatches=(d:Due)=>!search.trim()||[d.name,categories.find(c=>c.id===d.category_id)?.name??''].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
const filteredDues=$derived(scopedDues.filter(d=>statusMatches(d)&&searchMatches(d)&&(!accountFilter||d.account_id===Number(accountFilter))).sort((a,b)=>{
 if(sortBy==='amount')return remaining(b)-remaining(a)||a.due_date.localeCompare(b.due_date);
 if(sortBy==='urgency'){const ranks={late:0,partial:1,open:1,paid:2,cancelled:3};const delta=ranks[status(a)]-ranks[status(b)];if(delta)return delta;}
 return a.due_date.localeCompare(b.due_date)||a.id-b.id;
}));
const filteredBills=$derived(visibleBills.filter(b=>(!search.trim()||b.account_name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))&&(!accountFilter||b.account_id===Number(accountFilter))&&(statusFilter==='all'||(statusFilter==='paid'?b.total_cents<=b.paid_cents:statusFilter==='late'?b.due_date<localToday()&&b.total_cents>b.paid_cents:statusFilter==='open'?b.total_cents!==b.paid_cents:false))));

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
  const result: Record<string, { planned: number; paid: number; remaining: number; incomePlanned:number; incomeReceived:number; incomeRemaining:number }> = {};
  for (const row of [
    ...expenses
      .filter((d) => !d.cancelled)
      .map((d) => ({ account: d.account_id, total: d.amount_cents, paid: d.paid_cents })),
    ...visibleBills.map((b) => ({
      account: b.account_id,
      total: b.total_cents,
      paid: b.paid_cents,
    })),
  ]) {
    const currency = accounts.find((a) => a.id === row.account)?.currency ?? 'BRL';
    const total = result[currency] ?? { planned: 0, paid: 0, remaining: 0, incomePlanned:0,incomeReceived:0,incomeRemaining:0 };
    total.planned += row.total;
    total.paid += row.paid;
    total.remaining += Math.max(0, row.total - row.paid);
    result[currency] = total;
  }
  for(const row of incomes.filter(d=>!d.cancelled)){const currency=accounts.find(a=>a.id===row.account_id)?.currency??'BRL';const total=result[currency]??{planned:0,paid:0,remaining:0,incomePlanned:0,incomeReceived:0,incomeRemaining:0};total.incomePlanned+=row.amount_cents;total.incomeReceived+=row.paid_cents;total.incomeRemaining+=remaining(row);result[currency]=total;}
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

const remaining = (d: Due) => (d.cancelled ? 0 : Math.max(0, d.amount_cents - d.paid_cents));

function status(d: Due): 'paid' | 'late' | 'partial' | 'open' | 'cancelled' {
  if (d.cancelled) return 'cancelled';
  if (remaining(d) === 0) return 'paid';
  if (d.due_date < localToday()) return 'late';
  if (d.paid_cents > 0) return 'partial';
  return 'open';
}

function getDueDayBadge(dueDateStr: string): { text: string; urgent: boolean; late: boolean } {
  const todayStr = localToday();
  if (dueDateStr < todayStr) {
    const diff = Math.round((new Date(todayStr).getTime() - new Date(dueDateStr).getTime()) / (1000 * 3600 * 24));
    return { text: $t('payables.late_days',{n:diff}), urgent: true, late: true };
  }
  if (dueDateStr === todayStr) {
    return { text: $t('payables.due_today'), urgent: true, late: false };
  }
  const diff = Math.round((new Date(dueDateStr).getTime() - new Date(todayStr).getTime()) / (1000 * 3600 * 24));
  if (diff === 1) return { text: $t('payables.tomorrow'), urgent: true, late: false };
  return { text: $t('payables.due_days',{n:diff}), urgent: diff <= 3, late: false };
}

function tabKeydown(event:KeyboardEvent){const tabs=['commitments','income','bills'] as const;let index=tabs.indexOf(activeTab);if(event.key==='ArrowRight')index=(index+1)%3;else if(event.key==='ArrowLeft')index=(index+2)%3;else if(event.key==='Home')index=0;else if(event.key==='End')index=2;else return;event.preventDefault();activeTab=tabs[index]??'commitments';statusFilter=activeTab==='bills'?'all':'open';document.getElementById('tab-'+activeTab)?.focus();}

function prevMonth() {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 2, 1);
  month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonth() {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m, 1);
  month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function resetToCurrentMonth() {
  month = localToday().slice(0, 7);
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

let purchaseKey = '';
let purchasePayload = '';

async function create(event: SubmitEvent) {
  event.preventDefault();
  await action(async () => {
    if (kind === 'card') {
      const payload = {
        name,
        accountId: Number(account),
        categoryId: Number(category),
        amountCents: cents,
        installments: validCount,
        firstNumber: first,
        date,
        firstDue: due,
      };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== purchasePayload) {
        purchaseKey = crypto.randomUUID();
        purchasePayload = fingerprint;
      }
      await apiPost('/payables/purchases', { ...payload, key: purchaseKey });
      purchasePayload = '';
      purchaseKey = '';
    } else {
      await apiPost('/payables', {
        name,
        kind,
        accountId: Number(account),
        categoryId: Number(category),
        direction,
        amountCents: cents,
        installments: kind === 'once' ? 1 : validCount,
        firstNumber: kind === 'once' || kind === 'recurring' ? 1 : first,
        firstDue: due,
        details: { institution, contract, notes },
      });
    }
    name = '';
    amount = undefined;
    notice = label('created');
    activeTab=direction==='income'?'income':kind==='card'?'bills':'commitments';
    showCreateCard = false;
  });
}

function openPay(id: number, bill: boolean, balance: number, itemName?: string, income=false) {
  payment = { id, bill, remaining: balance, name: itemName, income };
  payAmount = balance / 100;
  payDate = localToday();
  paymentKey = crypto.randomUUID();
  void tick().then(() => {
    const el = document.querySelector<HTMLInputElement>('#payable-payment input');
    el?.focus();
  });
}

async function pay(event: SubmitEvent) {
  event.preventDefault();
  const p = payment;
  if (!p) return;
  await action(async () => {
    await apiPost(`/payables/${p.bill ? 'bills/' : ''}${p.id}/${p.income?'receive':'pay'}`, {
      amountCents: Math.round((payAmount ?? 0) * 100),
      date: payDate,
      key: paymentKey,
      ...(p.bill ? { sourceAccountId: Number(source) } : {}),
    });
    payment = null;
    notice = label(p.income?'received_notice':'recorded');
  });
}

function suggestDue() {
  const a = accounts.find((a) => a.id === Number(account));
  if (kind === 'card' && a?.statementDay && a.paymentDueDay) {
    due = firstCardDue(date, a.statementDay, a.paymentDueDay);
  }
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

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (payment) payment = null;
    else if (editing) editing = null;
    else if (contractView) contractView = null;
    else if (showConvertModal) showConvertModal = false;
  }
}
</script>

<svelte:head>
  <title>{$t('payables.title')} · HomeLedger</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="page payables-page">
  <!-- PAGE HEADER -->
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">{$t('payables.title')}</h1>
      <p class="page-subtitle">{$t('payables.description')}</p>
    </div>
    <div class="header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => (showConvertModal = true)}>
        <Icon name="repeat" size={14} /> {$t('payables.convert')}
      </button>
      <button class="btn btn-secondary" onclick={()=>{direction='income';kind='recurring';category='';activeTab='income';showCreateCard=true;}}>{$t('payables.add_income')}</button>
      <button class="btn btn-new" onclick={() => {if(direction==='income'){direction='expense';category='';showCreateCard=true;}else showCreateCard = !showCreateCard;}}>
        <Icon name={showCreateCard ? 'x' : 'plus'} size={14} />
        {showCreateCard&&direction==='expense' ? $t('common.close') : $t('payables.add')}
      </button>
    </div>
  </header>

  {#if notice}
    <div class="banner banner-success" role="status">
      <span>{notice}</span>
      <button class="btn-close-sm" onclick={() => (notice = '')}>&times;</button>
    </div>
  {/if}

  {#if error}
    <div class="banner banner-error" role="alert">
      <span>{error}</span>
      <button class="btn btn-sm btn-retry" onclick={load} disabled={busy}>{$t('payables.retry')}</button>
    </div>
  {/if}

  <section class="summary-cards" aria-label={$t('payables.month')}>
    {#each Object.entries(monthlyTotals) as [currency,totals]}
      <div class="summary-card"><div class="sc-content"><span class="sc-label">{$t('payables.remaining')} · {currency}</span><strong class="sc-value sc-orange">{currencyMoney(totals.remaining,currency)}</strong><span class="sc-meta">{$t('payables.planned')}: {currencyMoney(totals.planned,currency)}</span></div><span class="sc-icon orange"><Icon name="wallet" size={20}/></span></div>
      <div class="summary-card"><div class="sc-content"><span class="sc-label">{$t('payables.income_pending')} · {currency}</span><strong class="sc-value">{currencyMoney(totals.incomeRemaining,currency)}</strong><span class="sc-meta">{$t('payables.income_amount')}: {currencyMoney(totals.incomePlanned,currency)}</span></div><span class="sc-icon blue"><Icon name="calendar" size={20}/></span></div>
      <div class="summary-card"><div class="sc-content"><span class="sc-label">{$t('payables.income_received')} · {currency}</span><strong class="sc-value sc-green">{currencyMoney(totals.incomeReceived,currency)}</strong><span class="sc-meta">{$t('payables.paid')}: {currencyMoney(totals.paid,currency)}</span></div><span class="sc-icon green"><Icon name="check" size={20}/></span></div>
      <div class="summary-card"><div class="sc-content"><span class="sc-label">{$t('payables.monthly_result')} · {currency}</span><strong class="sc-value" class:sc-red={totals.incomePlanned<totals.planned}>{currencyMoney(totals.incomePlanned-totals.planned,currency)}</strong><span class="sc-meta">{$t('payables.result_hint')}</span></div></div>
    {/each}
  </section>

  <!-- CONTROLS BAR: Month Navigation & Tabs -->
  <div class="controls-bar">
    <div class="month-nav">
      <button class="btn btn-icon btn-sm" onclick={prevMonth} aria-label={$t('payables.previous_month')} title={$t('payables.previous_month')}>
        &lsaquo;
      </button>
      <input type="month" bind:value={month} class="month-input" aria-label={$t('payables.month')} />
      <button class="btn btn-icon btn-sm" onclick={nextMonth} aria-label={$t('payables.next_month')} title={$t('payables.next_month')}>
        &rsaquo;
      </button>
      {#if month !== localToday().slice(0, 7)}
        <button class="btn btn-secondary btn-sm" onclick={resetToCurrentMonth}>
          {$t('payables.current_month')}
        </button>
      {/if}
    </div>

    <div class="view-tabs" role="tablist" aria-label={$t('payables.direction')}>
      {#each [['commitments','expenses',expenses.length],['income','income',incomes.length],['bills','tab_bills',visibleBills.length]] as [tab,key,n]}
        <button type="button" role="tab" id={`tab-${tab}`} aria-selected={activeTab===tab} tabindex={activeTab===tab?0:-1} onkeydown={tabKeydown} aria-controls={`panel-${tab}`} class="tab-btn" class:active={activeTab===tab} onclick={()=>{activeTab=tab as typeof activeTab;statusFilter=tab==='bills'?'all':'open';}}>{label(String(key))}<span class="tab-count">{n}</span></button>
      {/each}
    </div>
  </div>

  <!-- ADD EXPENSE FORM (Accordion / Collapsible Card) -->
  {#if showCreateCard}
  <details class="card form-accordion" bind:open={showCreateCard}>
    <summary class="form-summary">
      <div class="summary-left">
        <Icon name="plus" size={16} />
        <span class="summary-title">{label(direction==='income'?'add_income':'add')}</span>
      </div>
      <span class="summary-toggle">{showCreateCard ? '▲' : '▼'}</span>
    </summary>

    <form onsubmit={create} class="modal-form">
      <div class="field"><label for="pay-direction">{$t('payables.direction')}</label><select id="pay-direction" bind:value={direction} onchange={()=>{category='';if(direction==='income')kind='recurring';}}><option value="expense">{$t('payables.expenses')}</option><option value="income">{$t('payables.income')}</option></select></div>
      <div class="field-row">
        <div class="field">
          <label for="pay-kind">{label(direction==='income'?'income_kind':'kind')}</label>
          <select id="pay-kind" bind:value={kind} onchange={() => { account = ''; first = 1; }}>
            {#each (direction==='income'?['once','recurring']:['once', 'recurring', 'installment', 'consortium', 'housing', 'card']) as k}
              <option value={k}>{label(direction==='income'?'income_'+k:k)}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label for="pay-name">{$t('payables.name')}</label>
          <input id="pay-name" required maxlength="100" bind:value={name} placeholder={label(direction==='income'?'first_income_example':'expense_example')} />
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="pay-amount">{label(direction==='income'?'income_amount':kind === 'installment' || kind === 'card' ? 'total' : 'amount')}</label>
          <input
            id="pay-amount"
            required
            type="number"
            min="0.01"
            max="999999999.99"
            step="0.01"
            bind:value={amount}
            placeholder="0,00"
          />
        </div>

        {#if !['once', 'recurring'].includes(kind)}
          <div class="field">
            <label for="pay-count">{$t('payables.count')}</label>
            <input id="pay-count" required type="number" min="1" max="600" bind:value={count} />
          </div>
        {/if}

        {#if ['installment', 'consortium', 'housing', 'card'].includes(kind)}
          <div class="field">
            <label for="pay-first">{$t('payables.first')}</label>
            <input id="pay-first" required type="number" min="1" max={count} bind:value={first} />
          </div>
        {/if}

        <div class="field">
          <label for="pay-due">{label(direction==='income'?'income_due':kind === 'card' ? 'first_bill' : 'due')}</label>
          <input id="pay-due" required type="date" bind:value={due} />
        </div>
      </div>

      {#if kind === 'card'}
        <div class="field-row">
          <div class="field">
            <label for="pay-date">{$t('payables.purchase_date')}</label>
            <input id="pay-date" required type="date" max={due} bind:value={date} onchange={suggestDue} />
          </div>
        </div>
      {/if}

      <div class="field-row">
        <div class="field">
          <label for="pay-account">{label(direction==='income'?'income_account':'account')}</label>
          <select id="pay-account" required bind:value={account} onchange={suggestDue}>
            <option value="">{$t('payables.select')}</option>
            {#each accounts.filter((a) => (kind === 'card' ? a.type === 'Crédito' : a.type !== 'Crédito')) as a}
              <option value={a.id}>{a.name} ({a.currency})</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label for="pay-category">{$t('payables.category')}</label>
          <select id="pay-category" required bind:value={category}>
            <option value="">{$t('payables.select')}</option>
            {#each categories.filter((c) => direction==='income'?c.type!=='Gasto':c.type!=='Ingreso') as c}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
        </div>
      </div>

      {#if ['consortium', 'housing'].includes(kind)}
        <div class="field-row">
          <div class="field">
            <label for="pay-institution">{$t('payables.institution')}</label>
            <input id="pay-institution" maxlength="100" bind:value={institution} placeholder="Ex: Caixa, Bradesco..." />
          </div>
          <div class="field">
            <label for="pay-contract">{$t('payables.contract')}</label>
            <input id="pay-contract" maxlength="100" bind:value={contract} placeholder="Ex: 12345 / Grupo 001 Cota 02" />
          </div>
        </div>
        <div class="field">
          <label for="pay-notes">{$t('payables.notes')}</label>
          <textarea id="pay-notes" maxlength="2000" bind:value={notes} placeholder="Observações do contrato, indexador..."></textarea>
        </div>
        <p class="field-hint">{$t('payables.contract_hint')}</p>
      {/if}

      {#if kind === 'card'}
        <p class="field-hint">{$t('payables.card_hint')}</p>
      {/if}

      {#if kind === 'recurring'}
        <p class="field-hint">{label(direction==='income'?'income_hint':'recurring_hint')}</p>
      {/if}

      <!-- PREVIEW PARCELAS -->
      <div class="preview-box">
        <span class="preview-label">{$t('payables.preview')}:</span>
        <div class="preview-tags">
          {#each preview as p}
            <span class="preview-pill">
              {p.n}/{kind === 'recurring' ? '∞' : kind === 'once' ? 1 : validCount}: {money(p.amount, Number(account))}
            </span>
          {/each}
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn-cancel" onclick={() => (showCreateCard = false)}>
          {$t('common.cancel')}
        </button>
        <button type="submit" class="btn-submit" disabled={busy}>
          {$t('payables.save')}
        </button>
      </div>
    </form>
  </details>
  {/if}

  <div class="list-filters">
    {#if search||accountFilter||statusFilter!=='open'}<button class="btn btn-secondary btn-sm" onclick={()=>{search='';accountFilter='';statusFilter='open';sortBy='urgency';}}>{$t('payables.clear_filters')}</button>{/if}
    <label>{$t('payables.search')}<input type="search" bind:value={search}/></label>
    <details class="advanced-filters"><summary>{$t('transactions.filters')}</summary><div class="advanced-fields"><label>{$t('payables.account_filter')}<select bind:value={accountFilter}><option value="">{$t('payables.all_accounts')}</option>{#each accounts as a}<option value={a.id}>{a.name}</option>{/each}</select></label>
    <label>{$t('payables.sort')}<select bind:value={sortBy}><option value="urgency">{$t('payables.sort_urgency')}</option><option value="date">{$t('payables.sort_date')}</option><option value="amount">{$t('payables.sort_amount')}</option></select></label>
    </div></details>
    <div class="filter-pills">{#each ['all','open','paid','late','cancelled'] as f}<button class="pill-btn" class:active={statusFilter===f} aria-pressed={statusFilter===f} onclick={()=>statusFilter=f as typeof statusFilter}>{f==='cancelled'?label('cancelled'):f==='paid'&&activeTab==='income'?label('received'):label('filter_'+f)}</button>{/each}</div>
  </div>
  {#if activeTab!=='bills'}
  <div id={`panel-${activeTab}`} role="tabpanel" tabindex="0" aria-labelledby={`tab-${activeTab}`} class="section-container">
    <div class="section-header"><h2 class="section-title">{label(activeTab==='income'?'income':'expenses')}</h2><span class="sc-meta">{$t('payables.matched',{n:filteredDues.length})}</span></div>
    {#if loading}<div class="state-msg"><div class="spinner"></div><p>{$t('payables.loading')}</p></div>
    {:else if !filteredDues.length}<div class="card state-msg empty-card"><Icon name="calendar" size={28} class="empty-icon"/><p class="empty-title">{$t('payables.empty_filtered')}</p></div>
    {:else}
      <div class="expense-list">
      {#each filteredDues as d (d.id)}
        {@const st=status(d)}{@const income=d.direction==='income'}
        <article class="card payable-card compact-row" class:card-late={st==='late'}>
          <div class="row-name"><h3 class="pc-name">{d.name}</h3><div class="pc-badges"><span class="badge" class:badge-green={st==='paid'} class:badge-red={st==='late'} class:badge-yellow={st!=='paid'&&st!=='late'}>{label(income&&st==='paid'?'received':st)}</span><span class="pc-meta-item">{categories.find(c=>c.id===d.category_id)?.name??label(d.kind)}</span></div></div>
          <div class="row-date"><span class="pc-due-date">{formatLocalDate(d.due_date,getIntlTag($preferences.locale))}</span>{#if st!=='paid'&&st!=='cancelled'}<small class:sc-red={st==='late'}>{income?$t('payables.future_income',{date:formatLocalDate(d.due_date,getIntlTag($preferences.locale))}):getDueDayBadge(d.due_date).text}</small>{/if}</div>
          <div class="row-account"><span>{d.account_name??accounts.find(a=>a.id===d.account_id)?.name}</span><small>{d.kind==='recurring'?label(income?'income_recurring':'recurring'):d.total_installments>1?$t('payables.installment_number',{n:d.number,total:d.total_installments}):label(d.kind)}</small></div>
          <div class="row-money"><strong class:sc-green={income}>{money(d.amount_cents,d.account_id)}</strong>{#if d.paid_cents>0&&remaining(d)>0}<small>{label(income?'income_pending':'remaining')}: {money(remaining(d),d.account_id)}</small>{/if}</div>
          <div class="row-actions">
            {#if remaining(d)>0}<button class="btn btn-sm btn-primary" disabled={busy} onclick={()=>openPay(d.id,false,remaining(d),d.name,income)}>{label(income?'receive':'pay')}</button>{/if}
            <details class="row-more"><summary>{$t('payables.more')}</summary><div class="secondary-actions">
              {#if ['housing','consortium'].includes(d.kind)}<button class="btn btn-sm btn-secondary" disabled={busy} onclick={()=>showContract(d.commitment_id)}>{$t('payables.contract_details')}</button>{/if}
              {#if !d.cancelled&&!d.paid_cents}<button class="btn btn-sm btn-secondary" disabled={busy} onclick={()=>{editing=d;editAmount=d.amount_cents/100;future=false;}}>{$t('payables.edit')}</button><button class="btn btn-sm btn-danger-sm" disabled={busy} onclick={()=>{if(confirm(label('confirm_cancel')))void action(()=>apiPost(`/payables/${d.id}/cancel`,{}));}}>{$t('payables.cancel')}</button>{/if}
              {#if !d.cancelled&&remaining(d)>0}<button class="btn btn-sm btn-danger-sm" disabled={busy} onclick={()=>{if(confirm(label('confirm_stop')))void action(()=>apiPost(`/payables/commitments/${d.commitment_id}/stop`,{}));}}>{$t('payables.stop')}</button>{/if}
            </div></details>
          </div>
        </article>
      {/each}
      </div>
    {/if}
  </div>
  {/if}

  <!-- SEÇÃO 2: FATURAS DE CARTÃO -->
  {#if activeTab==='bills'}
  <div id="panel-bills" role="tabpanel" tabindex="0" aria-labelledby="tab-bills" class="section-container">
    <div class="section-header">
      <h2 class="section-title">
        <Icon name="credit-card" size={16} /> {$t('payables.bills')}
      </h2>
    </div>
    <CardReconcile {accounts} {busy} refreshed={load} />

    {#if filteredBills.length === 0}
      <div class="card state-msg empty-card">
        <Icon name="credit-card" size={32} class="empty-icon" />
        <p class="empty-title">{$t('payables.empty')}</p>
      </div>
    {:else}
      <div class="payables-grid">
        {#each filteredBills as b (b.id)}
          {@const remainingCents = Math.abs(b.total_cents - b.paid_cents)}
          <article class="card payable-card">
            <div class="pc-top">
              <div class="pc-title-col">
                <h3 class="pc-name">{b.account_name}</h3>
                <span class="badge {b.closed ? 'badge-subtle' : 'badge-yellow'}">
                  {label(b.closed ? 'closed' : 'open')}
                </span>
              </div>
              <div class="pc-day-col">
                <span class="pc-due-date">{formatLocalDate(b.due_date, getIntlTag($preferences.locale))}</span>
              </div>
            </div>

            <div class="pc-info">
              <div class="pc-amounts-box">
                <div class="pc-amount-item">
                  <span class="pc-label">Total da fatura:</span>
                  <span class="pc-val">{money(b.total_cents, b.account_id)}</span>
                </div>
                {#if b.paid_cents > 0}
                  <div class="pc-amount-item">
                    <span class="pc-label">Pago:</span>
                    <span class="pc-val sc-green">{money(b.paid_cents, b.account_id)}</span>
                  </div>
                {/if}
                <div class="pc-amount-item pc-remaining-item">
                  <span class="pc-label">{label(b.total_cents < b.paid_cents ? 'credit' : 'remaining')}:</span>
                  <span class="pc-val-remaining {b.total_cents > b.paid_cents ? 'sc-orange' : 'sc-green'}">
                    {money(remainingCents, b.account_id)}
                  </span>
                </div>
              </div>
            </div>

            <div class="pc-actions">
              {#if !b.closed}
                <button
                  class="btn btn-sm btn-secondary"
                  disabled={busy}
                  onclick={() => action(() => apiPost(`/payables/bills/${b.id}/close`, {}))}
                >
                  {$t('payables.close')}
                </button>
              {/if}

              {#if b.total_cents > b.paid_cents}
                <button
                  class="btn btn-sm btn-primary"
                  disabled={busy}
                  onclick={() => openPay(b.id, true, b.total_cents - b.paid_cents, b.account_name)}
                >
                  {$t('payables.pay')}
                </button>
              {/if}
            </div>

            <CardBillTools bill={b} {busy} refreshed={load} />
          </article>
        {/each}
      </div>
    {/if}
  </div>
  {/if}
</div>

<!-- ═══════════════════════════════════════════
     MODAIS PADRONIZADOS
     ═══════════════════════════════════════════ -->

<!-- MODAL: REGISTRAR PAGAMENTO -->
{#if payment}
  <div
    id="payable-payment"
    class="overlay modal-backdrop"
    role="region"
    aria-label={label(payment.income?'receive':'pay')}
    transition:scrim
  >
    <div class="modal" role="document" transition:modalPanel>
      <header class="modal-header">
        <h2>{label(payment.income?'receive':'pay')} {#if payment.name}— {payment.name}{/if}</h2>
        <button class="close-btn" onclick={() => (payment = null)} aria-label={$t('common.close')}>&times;</button>
      </header>

      <form onsubmit={pay} class="modal-form">
        <div class="field">
          <label for="pay-amount-input">{label(payment.income?'received_amount':'amount')}</label>
          <input
            id="pay-amount-input"
            required
            type="number"
            min="0.01"
            max={payment.remaining / 100}
            step="0.01"
            bind:value={payAmount}
          />
        </div>

        <div class="field">
          <label for="pay-date-input">{label(payment.income?'received_date':'date')}</label>
          <input id="pay-date-input" required type="date" bind:value={payDate} />
        </div>

        {#if payment.bill}
          <div class="field">
            <label for="pay-source-acc">{$t('payables.account')}</label>
            <select id="pay-source-acc" required bind:value={source}>
              <option value="">{$t('payables.select')}</option>
              {#each accounts.filter((a) => a.type !== 'Crédito') as a}
                <option value={a.id}>{a.name} ({a.currency})</option>
              {/each}
            </select>
          </div>
        {/if}

        <div class="modal-actions">
          <button type="button" class="btn-cancel" onclick={() => (payment = null)}>
            {$t('common.close')}
          </button>
          <button type="submit" class="btn-submit" disabled={busy}>
            {label(payment.income?'receive':'pay')}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- MODAL: AJUSTAR VALOR / EDITAR -->
{#if editing}
  <div class="overlay modal-backdrop" role="dialog" aria-modal="true" transition:scrim>
    <div class="modal modal-sm" role="document" transition:modalPanel>
      <header class="modal-header">
        <h2>{$t('payables.edit')}</h2>
        <button class="close-btn" onclick={() => (editing = null)} aria-label={$t('common.close')}>&times;</button>
      </header>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          const row = editing;
          if (row) {
            void action(async () => {
              await apiPatch(`/payables/${row.id}`, {
                amountCents: Math.round((editAmount ?? 0) * 100),
                scope: future ? 'future' : 'one',
              });
              editing = null;
            });
          }
        }}
        class="modal-form"
      >
        <div class="field">
          <label for="edit-amount">{$t('payables.amount')}</label>
          <input id="edit-amount" required type="number" min="0.01" step="0.01" bind:value={editAmount} />
        </div>

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={future} />
          <span>{$t('payables.future')}</span>
        </label>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" onclick={() => (editing = null)}>
            {$t('common.close')}
          </button>
          <button type="submit" class="btn-submit" disabled={busy}>
            {$t('payables.save')}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- MODAL: CONTRATO E HISTÓRICO -->
{#if contractView}
  <div class="overlay modal-backdrop" role="dialog" aria-modal="true" transition:scrim>
    <div class="modal modal-wide" role="document" transition:modalPanel>
      <header class="modal-header">
        <h2>{contractView.name}</h2>
        <button class="close-btn" onclick={() => (contractView = null)} aria-label={$t('common.close')}>&times;</button>
      </header>

      <div class="modal-form">
        <div class="contract-header-info">
          <p><strong>{JSON.parse(contractView.details).institution}</strong> · {JSON.parse(contractView.details).contract}</p>
          {#if JSON.parse(contractView.details).notes}
            <p class="field-hint">{JSON.parse(contractView.details).notes}</p>
          {/if}
          {#if JSON.parse(contractView.details).outstandingCents !== undefined}
            <p class="sc-orange">
              <strong>{$t('payables.outstanding')}:</strong>
              {money(JSON.parse(contractView.details).outstandingCents)} ({JSON.parse(contractView.details).referenceDate})
            </p>
          {/if}
        </div>

        <h3 class="section-subtitle">{$t('payables.event')}</h3>
        <form onsubmit={saveEvent} class="event-form">
          <div class="field-row">
            <div class="field">
              <label for="event-kind">{$t('payables.kind')}</label>
              <select id="event-kind" bind:value={eventKind}>
                {#each ['balance', 'amortization', 'bid', 'contemplation', 'adjustment'] as k}
                  <option value={k}>{label(k)}</option>
                {/each}
              </select>
            </div>
            <div class="field">
              <label for="event-date">{$t('payables.date')}</label>
              <input id="event-date" required type="date" bind:value={eventDate} />
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="event-amount">{$t('payables.amount')}</label>
              <input id="event-amount" type="number" min="0" step="0.01" bind:value={eventAmount} placeholder="0,00" />
            </div>
            <div class="field">
              <label for="event-outstanding">{$t('payables.outstanding')}</label>
              <input id="event-outstanding" type="number" min="0" step="0.01" bind:value={outstanding} placeholder="0,00" />
            </div>
          </div>

          <div class="field">
            <label for="event-notes">{$t('payables.notes')}</label>
            <textarea id="event-notes" maxlength="2000" bind:value={eventNotes} placeholder="Notas do evento..."></textarea>
          </div>

          <label class="checkbox-label">
            <input type="checkbox" bind:checked={recordExpense} />
            <span>{$t('payables.record_expense')}</span>
          </label>

          <button class="btn btn-primary btn-sm" disabled={busy}>
            {$t('payables.save')}
          </button>
        </form>

        <h3 class="section-subtitle">Histórico de eventos</h3>
        <ul class="events-list">
          {#each contractView.events as ev}
            <li class="event-item">
              <span class="event-date">{formatLocalDate(ev.date, getIntlTag($preferences.locale))}</span>
              <span class="badge badge-subtle">{label(ev.kind)}</span>
              <span class="event-amt">{money(ev.amount_cents)}</span>
              {#if ev.notes}<span class="event-note">· {ev.notes}</span>{/if}
              {#if ev.outstanding_cents !== null}
                <span class="event-out">· {$t('payables.outstanding')}: {money(ev.outstanding_cents)}</span>
              {/if}
            </li>
          {:else}
            <li class="empty-text">Nenhum evento registrado ainda.</li>
          {/each}
        </ul>
      </div>
    </div>
  </div>
{/if}

<!-- MODAL: CONVERTER ASSINATURA -->
{#if showConvertModal}
  <div class="overlay modal-backdrop" role="dialog" aria-modal="true" transition:scrim>
    <div class="modal modal-sm" role="document" transition:modalPanel>
      <header class="modal-header">
        <h2>{$t('payables.convert')}</h2>
        <button class="close-btn" onclick={() => (showConvertModal = false)} aria-label={$t('common.close')}>&times;</button>
      </header>

      <form
        class="modal-form"
        onsubmit={(e) => {
          e.preventDefault();
          if (!subscription) return;
          void action(async () => {
            await apiPost(`/payables/subscriptions/${subscription}/convert`, {});
            showConvertModal = false;
            subscription = '';
          });
        }}
      >
        <p class="field-hint">{$t('payables.convert_hint')}</p>

        <div class="field">
          <label for="conv-sub">{$t('nav.subscriptions')}</label>
          <select id="conv-sub" required bind:value={subscription}>
            <option value="">{$t('payables.select')}</option>
            {#each subscriptions.filter((s) => s.cycle === 'Mensual' && s.status === 'Activa') as sub}
              <option value={sub.id}>{sub.name}</option>
            {/each}
          </select>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" onclick={() => (showConvertModal = false)}>
            {$t('common.close')}
          </button>
          <button type="submit" class="btn-submit" disabled={busy || !subscription}>
            {$t('payables.convert')}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
.payables-page {
  padding: 1.25rem;
  max-width: 1400px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.page-subtitle {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-top: 0.2rem;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

/* ─── Buttons ─── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.85rem;
  font-size: 0.82rem;
  font-weight: 500;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-sm {
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
}

.btn-new,
.btn-primary {
  background: var(--accent-blue);
  color: #fff;
  border: none;
}
.btn-new:hover,
.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  background: var(--bg-elevated);
  border-color: var(--border-default);
  color: var(--text-secondary);
}
.btn-secondary:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-danger-sm {
  background: var(--tag-red-bg);
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
  padding: 0.25rem 0.5rem;
  font-size: 0.72rem;
  border-radius: var(--radius-sm);
}
.btn-danger-sm:hover {
  background: var(--accent-red);
  color: #fff;
}

.btn-icon {
  width: 2rem;
  height: 2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  font-size: 1.1rem;
}

/* ─── Banners ─── */
.banner {
  padding: 0.65rem 1rem;
  border-radius: var(--radius-md);
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.82rem;
}
.banner-success {
  background: rgba(34, 197, 94, 0.12);
  color: var(--accent-green);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.banner-error {
  background: rgba(239, 68, 68, 0.12);
  color: var(--accent-red);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.btn-close-sm {
  background: none;
  border: none;
  color: inherit;
  font-size: 1.2rem;
  cursor: pointer;
}

/* ─── Summary Cards ─── */
.summary-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0.85rem;
  margin-bottom: 1.25rem;
}

.summary-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 1rem 1.15rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  box-shadow: var(--shadow-sm);
}

.sc-content {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.sc-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--tracking-label);
  color: var(--text-muted);
}

.sc-value {
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.sc-meta {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.sc-green { color: var(--accent-green); }
.sc-orange { color: var(--accent-orange, #f59e0b); }
.sc-red { color: var(--accent-red); }

.sc-icon {
  width: 2.2rem;
  height: 2.2rem;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sc-icon.blue { background: rgba(59, 130, 246, 0.15); color: var(--accent-blue); }
.sc-icon.green { background: rgba(34, 197, 94, 0.15); color: var(--accent-green); }
.sc-icon.orange { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }

/* ─── Controls Bar ─── */
.section-container {
  margin-bottom: 2rem;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.85rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.section-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
}

.controls-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.month-nav {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.month-input {
  width: auto;
  padding: 0.35rem 0.65rem;
  font-size: 0.85rem;
  font-weight: 600;
}

.view-tabs {
  display: flex;
  background: var(--bg-elevated);
  padding: 0.2rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  gap: 0.2rem;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 500;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.active {
  background: var(--bg-card);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.tab-count {
  font-size: 0.7rem;
  background: var(--bg-hover);
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  color: var(--text-secondary);
}

/* ─── Filter Pills ─── */
.filter-pills {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.pill-btn {
  padding: 0.25rem 0.65rem;
  font-size: 0.75rem;
  border-radius: 999px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  transition: all 0.15s;
}
.pill-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.pill-btn.active {
  background: var(--accent-blue);
  color: #fff;
  border-color: var(--accent-blue);
}

/* ─── Form Accordion ─── */
.form-accordion {
  margin-bottom: 1.25rem;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.form-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1.15rem;
  cursor: pointer;
  user-select: none;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text-primary);
}
.form-summary:hover {
  background: var(--bg-hover);
}
.summary-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.summary-toggle {
  color: var(--text-muted);
  font-size: 0.75rem;
}

.field-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.4;
  margin-top: 0.25rem;
}

.preview-box {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 0.65rem 0.85rem;
  margin-top: 0.5rem;
}
.preview-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 0.35rem;
  display: block;
}
.preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.preview-pill {
  font-size: 0.72rem;
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 0.2rem 0.45rem;
  color: var(--text-secondary);
}

/* ─── Payables Grid & Cards ─── */
.payables-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 0.85rem;
}

.payable-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0.85rem;
  box-shadow: var(--shadow-sm);
  transition: border-color var(--transition-fast), transform var(--transition-fast);
}
.payable-card:hover {
  border-color: var(--border-default);
}
.payable-card.card-late {
  border-left: 3px solid var(--accent-red);
}

.pc-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}
.pc-title-col {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.pc-name {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pc-badges {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.badge {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.15rem 0.45rem;
  border-radius: var(--radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.badge-green { background: rgba(34, 197, 94, 0.15); color: var(--accent-green); }
.badge-yellow { background: rgba(245, 158, 11, 0.15); color: var(--accent-orange, #f59e0b); }
.badge-red { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); }
.badge-subtle { background: var(--bg-elevated); color: var(--text-muted); border: 1px solid var(--border-subtle); }

.pc-day-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.15rem;
  flex-shrink: 0;
}
.pc-due-date {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.pc-meta-item {
  font-size: 0.72rem;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.pc-amounts-box {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 0.65rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.pc-amount-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.78rem;
}
.pc-label {
  color: var(--text-muted);
}
.pc-val {
  font-weight: 500;
  color: var(--text-secondary);
}
.pc-remaining-item {
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.25rem;
  margin-top: 0.15rem;
}
.pc-val-remaining {
  font-size: 0.95rem;
  font-weight: 700;
}

.pc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  padding-top: 0.35rem;
  border-top: 1px solid var(--border-subtle);
}

/* ─── State Messages & Empty ─── */
.state-msg {
  padding: 2.5rem 1rem;
  text-align: center;
  color: var(--text-muted);
}
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.65rem;
}
.empty-title {
  font-size: 0.95rem;
  color: var(--text-secondary);
}
.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 0.75rem;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ─── Checkbox label ─── */
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
}
.checkbox-label input[type="checkbox"] {
  width: auto;
  cursor: pointer;
}

/* ─── Contract Details Modal Specifics ─── */
.contract-header-info {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 0.85rem;
  margin-bottom: 1rem;
  font-size: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.section-subtitle {
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--tracking-label);
  color: var(--text-muted);
  margin: 0.75rem 0 0.4rem;
}
.event-form {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  background: var(--bg-elevated);
  padding: 0.85rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  margin-bottom: 1rem;
}
.events-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 200px;
  overflow-y: auto;
}
.event-item {
  font-size: 0.78rem;
  padding: 0.4rem 0.65rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.event-date { font-weight: 600; color: var(--text-primary); }
.event-amt { font-weight: 600; color: var(--accent-blue); }
.event-note { color: var(--text-muted); }
.event-out { color: var(--accent-orange, #f59e0b); }
.empty-text { font-size: 0.78rem; color: var(--text-muted); }

.list-filters{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end;margin-bottom:1.2rem;padding:1rem;background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-lg)}
.list-filters label{display:flex;flex-direction:column;gap:.35rem;font-size:.75rem;color:var(--text-muted);flex:1;min-width:160px}.list-filters input,.list-filters select{padding:.55rem;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-elevated);color:var(--text-primary);font:inherit}.list-filters .filter-pills{flex-basis:100%;gap:.4rem}
.expense-list{display:flex;flex-direction:column;gap:.5rem}.compact-row{display:grid;grid-template-columns:minmax(160px,1.5fr) minmax(115px,.8fr) minmax(140px,1fr) minmax(110px,.8fr) minmax(160px,1fr);align-items:center;gap:1rem;padding:1rem}.row-date,.row-account,.row-money{display:flex;flex-direction:column;gap:.25rem}.row-date small,.row-account small,.row-money small{font-size:.72rem;color:var(--text-muted)}.row-money{align-items:end}.row-money strong{font-variant-numeric:tabular-nums}.row-actions{display:flex;justify-content:end;align-items:center;gap:.5rem;flex-wrap:wrap}.row-more summary{font-size:.73rem;cursor:pointer;color:var(--text-muted)}.secondary-actions{display:flex;gap:.5rem;flex-wrap:wrap;padding-top:.6rem}.row-more[open]{flex-basis:100%}.controls-bar{flex-wrap:wrap}.view-tabs{flex-wrap:wrap}.header-actions{flex-wrap:wrap}.summary-cards{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
@media(max-width:1100px){.compact-row{grid-template-columns:minmax(150px,1.4fr) minmax(100px,1fr) minmax(100px,1fr)}.row-account{grid-column:1}.row-actions{grid-column:2/4;grid-row:2}.row-money{grid-column:3;grid-row:1}}
@media(max-width:600px){.payables-page{padding:.75rem}.compact-row{grid-template-columns:minmax(0,1fr) auto;gap:.75rem}.row-name{min-width:0}.row-name h3{overflow-wrap:anywhere}.row-date{grid-column:1;grid-row:2}.row-money{grid-column:2;grid-row:1}.row-account{grid-column:2;grid-row:2;text-align:right}.row-actions{grid-column:1/-1;grid-row:3;justify-content:space-between}.header-actions{width:100%}.controls-bar{align-items:stretch}.view-tabs{width:100%}.list-filters label{min-width:120px}.summary-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.sc-value{font-size:1.1rem}.sc-icon{display:none}}

.advanced-filters summary{cursor:pointer;padding:.5rem;font-size:.78rem;color:var(--text-secondary)}.advanced-fields{display:flex;gap:.75rem;flex-wrap:wrap;padding:.5rem}.advanced-filters[open]{flex:1;min-width:260px}.advanced-fields label{min-width:120px}:global([data-ui='cyberpunk']) .pill-btn.active{color:#080b0b}
</style>
