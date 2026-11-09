/** Closing day belongs to the next cycle; the bank's actual cycle remains editable. */
export function firstCardDue(date: string, closingDay: number, dueDay: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const effectiveClosing = Math.min(closingDay, lastDay);
  const closingMonth = month - 1 + (day >= effectiveClosing ? 1 : 0);
  const dueMonth = closingMonth + (dueDay <= closingDay ? 1 : 0);
  const first = new Date(Date.UTC(year, dueMonth, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dueDay, last));
  return first.toISOString().slice(0, 10);
}
