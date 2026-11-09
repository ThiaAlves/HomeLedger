<script lang="ts">
  import { apiGet, apiPost } from '$lib/api/client';
  import { t } from '$lib/i18n';
  import { firstCardDue } from '$lib/utils/card-dates';
  let { accounts, busy=false, refreshed }: { accounts:{id:number;name:string;type:string;currency:string;statementDay?:number;paymentDueDay?:number}[];busy?:boolean;refreshed:()=>Promise<void> }=$props();
  let account=$state(''), transaction=$state(''), dueDate=$state(''), working=$state(false), error=$state(''), key=$state('');
  let entries=$state<{id:number;name:string;amount:number;type:string;date:string}[]>([]);
  let revision=0;
  async function read(){const version=++revision;working=true;error='';entries=[];transaction='';try{const data=await apiGet<typeof entries>(`/payables/cards/${account}/unassigned`);if(version===revision)entries=data;}catch(e){if(version===revision)error=e instanceof Error?e.message:String(e);}finally{if(version===revision)working=false;}}
  function suggest(){key=crypto.randomUUID();const a=accounts.find(a=>a.id===Number(account));const entry=entries.find(e=>e.id===Number(transaction));if(a?.statementDay&&a.paymentDueDay&&entry)dueDate=firstCardDue(entry.date.slice(0,10),a.statementDay,a.paymentDueDay);}
  async function submit(e:SubmitEvent){e.preventDefault();if(working||busy)return;working=true;error='';try{await apiPost(`/payables/transactions/${transaction}/assign`,{dueDate,key});await refreshed();await read();}catch(e){error=e instanceof Error?e.message:String(e);}finally{working=false;}}
</script>
<details class="reconcile"><summary>{$t('payables.link_existing')}</summary><p>{$t('payables.link_hint')}</p>
  <form onsubmit={submit}>
    <label>{$t('payables.card_account')}<select required bind:value={account} onchange={read}><option value="">{$t('payables.select')}</option>{#each accounts.filter(a=>a.type==='Crédito') as a}<option value={a.id}>{a.name}</option>{/each}</select></label>
    <label>{$t('payables.unassigned')}<select required bind:value={transaction} onchange={suggest}><option value="">{$t('payables.select')}</option>{#each entries as entry}<option value={entry.id}>{entry.date.slice(0,10)} · {entry.name} · {entry.amount}</option>{/each}</select></label>
    <label>{$t('payables.carry_due')}<input required type="date" bind:value={dueDate}/></label>
    <button disabled={busy||working}>{$t('payables.save')}</button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}
</details>
<style>.reconcile{border:1px solid var(--border-default,#7777);border-radius:8px;padding:1rem;margin-bottom:1rem}summary{cursor:pointer}form{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end}label{display:flex;flex-direction:column;gap:.4rem;min-width:200px}input,select,button{padding:.6rem;font:inherit;color:inherit;background:var(--bg-secondary);border:1px solid var(--border-default,#7777);border-radius:6px}button{cursor:pointer}p{line-height:1.5}[role=alert]{color:var(--accent-red,#d55)}</style>
