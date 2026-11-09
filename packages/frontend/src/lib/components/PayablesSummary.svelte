<script lang="ts">
import { onMount } from 'svelte';
import { apiGet } from '$lib/api/client';
import { t } from '$lib/i18n';
import { preferences } from '$lib/stores/preferences';
import { getIntlTag } from '$lib/i18n/registry';
type Entry = {
  due_date: string;
  direction?: string;
  amount_cents?: number;
  total_cents?: number;
  paid_cents: number;
  cancelled?: number;
  account_id: number;
};
let totals=$state<Record<string,{pending:number;received:number}>>({});
let error=$state(false);
onMount(()=>{void(async()=>{try{const [dues,accounts]=await Promise.all([apiGet<Entry[]>('/payables'),apiGet<{id:number;currency:string}[]>('/accounts')]);const today=new Date();const month=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;const next:typeof totals={};for(const row of dues)if(row.direction==='income'&&!row.cancelled&&row.due_date.startsWith(month)){const currency=accounts.find(a=>a.id===row.account_id)?.currency??'BRL';const item=next[currency]??{pending:0,received:0};item.pending+=Math.max(0,(row.amount_cents??0)-row.paid_cents);item.received+=row.paid_cents;next[currency]=item;}totals=next;}catch{error=true;}})();});
const money=(value:number,currency:string)=>new Intl.NumberFormat(getIntlTag($preferences.locale),{style:'currency',currency}).format(value/100);
</script>
{#if Object.keys(totals).length||error}
<a class="payables-summary" href="/contas-a-pagar"><strong>{$t('payables.income')} →</strong><span>{#each Object.entries(totals) as [currency,value]}<b>{$t('payables.income_pending')}: {money(value.pending,currency)}</b><b>{$t('payables.received')}: {money(value.received,currency)}</b>{/each}{#if error}…{/if}</span></a>
{/if}
<style>
.payables-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--border-color, #7777);
  border-radius: 10px;
  color: var(--text-primary);
  text-decoration: none;
  margin-bottom: 1rem;
}
span {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
