<script lang="ts">
  import { formatLocalDate } from '$lib/utils/local-date';
  import { tick, untrack } from 'svelte';
  import { apiGet, apiPost } from '$lib/api/client';
  import { t } from '$lib/i18n';
  import { preferences } from '$lib/stores/preferences';
  import { getIntlTag } from '$lib/i18n/registry';
  import type { TranslationKey } from '$lib/i18n/es';
  type Bill = { id: number; due_date: string; account_id: number; total_cents: number; paid_cents: number; closed: number };
  type Item = { id: number; purchase_id: number; name: string; number: number; installments: number; amount_cents: number; refundable_cents: number; purchase_date: string };
  type Payment = { id: number; amount_cents: number; date: string; source_account_name: string; reversal_transfer_id: number | null };
  type Movement = { id: number; from_bill_id: number; from_due: string; to_due: string; amount_cents: number; voided: number };
  let { bill, busy = false, refreshed }: { bill: Bill; busy?: boolean; refreshed: () => Promise<void> } = $props();
  let open = $state(false), working = $state(false), error = $state(''), notice = $state('');
  let items = $state<Item[]>([]), history = $state<{ payments: Payment[]; movements: Movement[] }>({ payments: [], movements: [] });
  let mode = $state<'refund' | 'anticipate' | 'carry' | null>(null), selected = $state<Item | null>(null);
  let amount = $state<number | undefined>(), dueDate = $state(''), fromNumber = $state(1), discount = $state<number | undefined>(0), operationKey = $state('');
  let currency = $state('BRL');
  const disabled = $derived(busy || working);
  const label = (key: string) => $t(('payables.' + key) as TranslationKey);
  const money = (cents: number) => new Intl.NumberFormat(getIntlTag($preferences.locale), { style: 'currency', currency }).format(cents / 100);
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  async function read() {
    const [nextItems, nextHistory, accounts] = await Promise.all([
      apiGet<Item[]>(`/payables/bills/${bill.id}/items`),
      apiGet<typeof history>(`/payables/bills/${bill.id}/history`),
      apiGet<{id: number; currency: string}[]>('/accounts'),
    ]);
    items = nextItems; history = nextHistory; currency = accounts.find(a => a.id === bill.account_id)?.currency ?? 'BRL';
  }
  async function run(work: () => Promise<unknown>, refresh = true) {
    if (disabled) return;
    working = true; error = ''; notice = '';
    try { await work(); if (refresh) { await read(); await refreshed(); notice = label('operation_done'); } }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { working = false; }
  }
  $effect(() => { const revision=[bill.id,bill.total_cents,bill.paid_cents,bill.closed].join(':'); if(open&&!busy)untrack(()=>{void revision;void run(read,false);}); });
  async function toggle() { open = !open; if (open) await run(read, false); }
  function choose(next: 'refund' | 'anticipate' | 'carry', item?: Item) {
    mode = next; selected = item ?? null; amount = item ? item.refundable_cents / 100 : undefined;
    dueDate = bill.due_date; fromNumber = item?.number ?? 1; discount = 0; operationKey = crypto.randomUUID();
    void tick().then(() => document.getElementById(`card-operation-${bill.id}`)?.scrollIntoView?.({behavior:'smooth'}));
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const current = mode, item = selected;
    await run(async () => {
      if (current === 'refund' && item) await apiPost(`/payables/purchases/${item.purchase_id}/refund`, { amountCents: Math.round((amount ?? 0)*100), dueDate, key: operationKey });
      if (current === 'anticipate' && item) await apiPost(`/payables/purchases/${item.purchase_id}/anticipate`, { fromNumber, dueDate, discountCents: Math.round((discount ?? 0)*100), key: operationKey });
      if (current === 'carry') await apiPost(`/payables/bills/${bill.id}/carry`, { dueDate, key: operationKey });
      mode = null;
    });
  }
</script>
<div class="card-tools">
  <div class="actions">
    <button disabled={disabled} onclick={toggle} aria-expanded={open}>{$t('payables.card_tools')}</button>
    {#if bill.closed}
      <button disabled={disabled} onclick={() => { if (confirm(label('confirm_reopen'))) void run(() => apiPost(`/payables/bills/${bill.id}/reopen`, {})); }}>{$t('payables.reopen')}</button>
    {/if}
    {#if bill.total_cents !== bill.paid_cents}
      <button disabled={disabled} onclick={() => choose('carry')}>{$t('payables.carry')}</button>
    {/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if open}
    <ul>
      {#each items as item (item.id)}
        <li><strong>{item.name}</strong> {#if item.number > 0}{item.number}/{item.installments}{:else}{$t('payables.refund')}{/if}: {money(item.amount_cents)}
          {#if item.amount_cents > 0 && item.refundable_cents > 0}
            <div class="actions">
              <button disabled={disabled} onclick={() => choose('refund', item)}>{$t('payables.refund')}</button>
              <button disabled={disabled} onclick={() => choose('anticipate', item)}>{$t('payables.anticipate')}</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <h3>{$t('payables.history')}</h3>
    <ul>{#each history.payments as p (p.id)}
      <li>{formatLocalDate(p.date,getIntlTag($preferences.locale))} · {p.source_account_name} · {money(p.amount_cents)}
        {#if p.reversal_transfer_id}<span>{$t('payables.undone')}</span>{:else}
          <button disabled={disabled} onclick={() => { if (confirm(label('confirm_undo_payment'))) void run(() => apiPost(`/payables/bills/${bill.id}/payments/${p.id}/undo`, { date: today() })); }}>{$t('payables.undo_payment')}</button>
        {/if}
      </li>
    {/each}</ul>
    {#if history.movements.length}<h3>{$t('payables.movements')}</h3>
    <ul>{#each history.movements as m (m.id)}
      <li>{formatLocalDate(m.from_due,getIntlTag($preferences.locale))} → {formatLocalDate(m.to_due,getIntlTag($preferences.locale))} · {money(m.amount_cents)}
        {#if m.voided}<span>{$t('payables.undone')}</span>{:else if m.from_bill_id === bill.id}
          <button disabled={disabled} onclick={() => run(() => apiPost(`/payables/bills/${bill.id}/movements/${m.id}/undo`, {}))}>{$t('payables.undo_carry')}</button>
        {/if}
      </li>
    {/each}</ul>{/if}
  {/if}
  {#if mode}
    <form id={`card-operation-${bill.id}`} onsubmit={submit} aria-label={label(mode === 'refund' ? 'refund' : mode === 'anticipate' ? 'anticipate' : 'carry')}>
      <p>{label(mode === 'refund' ? 'refund_hint' : mode === 'anticipate' ? 'anticipate_hint' : 'carry_hint')}</p>
      {#if selected}<strong>{selected.name}</strong>{/if}
      {#if mode === 'refund'}
        <label>{$t('payables.refund_amount')}<input required type="number" min="0.01" max={(selected?.refundable_cents ?? 0)/100} step="0.01" bind:value={amount}/></label>
      {/if}
      {#if mode === 'anticipate'}
        <label>{$t('payables.anticipate_from')}<input required type="number" min="1" max={selected?.installments} bind:value={fromNumber}/></label>
        <label>{$t('payables.discount')}<input required type="number" min="0" step="0.01" bind:value={discount}/></label>
      {/if}
      <label>{label(mode === 'refund' ? 'credit_due' : mode === 'anticipate' ? 'anticipate_due' : 'carry_due')}<input required type="date" min={mode === 'carry' ? undefined : selected?.purchase_date} bind:value={dueDate}/></label>
      <div class="actions"><button disabled={disabled}>{$t('payables.save')}</button><button type="button" disabled={disabled} onclick={() => mode = null}>{$t('common.close')}</button></div>
    </form>
  {/if}
</div>
<style>
.card-tools { margin-top: .75rem; } .actions { display:flex; flex-wrap:wrap; gap:.5rem; }
label { display:flex; flex-direction:column; gap:.4rem; margin:.75rem 0; }
button,input { font:inherit; color:inherit; background:var(--bg-secondary); border:1px solid var(--border-default,#7777); border-radius:6px; padding:.6rem; }
button { cursor:pointer; } button:disabled { opacity:.5; } ul { padding-left:1.25rem; } li { margin:.75rem 0; } form { border-top:1px solid var(--border-default,#7777); padding-top:.75rem; margin-top:.75rem; }
p { line-height:1.5; } [role=alert] { color:var(--accent-red,#d55); }
</style>
