<script lang="ts">
import { onMount } from 'svelte';
import { apiGet } from '$lib/api/client';
import { t } from '$lib/i18n';
import { preferences } from '$lib/stores/preferences';
import { getIntlTag } from '$lib/i18n/registry';
type Entry = {
  due_date: string;
  amount_cents?: number;
  total_cents?: number;
  paid_cents: number;
  cancelled?: number;
  account_id: number;
};
let totals = $state<Record<string, number>>({});
let error = $state(false);
onMount(() => {
  void (async () => {
    try {
      const [dues, bills, accounts] = await Promise.all([
        apiGet<Entry[]>('/payables'),
        apiGet<Entry[]>('/payables/bills'),
        apiGet<{ id: number; currency: string }[]>('/accounts'),
      ]);
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const sum: Record<string, number> = {};
      for (const row of [...dues, ...bills])
        if (!row.cancelled && row.due_date.startsWith(month)) {
          const currency = accounts.find((a) => a.id === row.account_id)?.currency ?? 'BRL';
          sum[currency] =
            (sum[currency] ?? 0) +
            Math.max(0, (row.amount_cents ?? row.total_cents ?? 0) - row.paid_cents);
        }
      totals = sum;
    } catch {
      error = true;
    }
  })();
});
</script>
<a class="payables-summary" href="/contas-a-pagar"><strong>{$t('payables.title')} →</strong><span>{$t('payables.remaining')}:
{#each Object.entries(totals) as [currency,value]}<b>{new Intl.NumberFormat(getIntlTag($preferences.locale),{style:'currency',currency}).format(value/100)}</b>
{/each}
{#if error}…
{/if}</span></a>
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
