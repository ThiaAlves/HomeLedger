import type Database from 'better-sqlite3';
export function isManagedEntry(db: Database.Database, id: number, transfer = false): boolean {
  const refs = transfer
    ? [
        ['card_bill_payments', 'transfer_id'],
        ['card_bill_payments', 'reversal_transfer_id'],
      ]
    : [
        ['payable_payments', 'transaction_id'],
        ['card_bill_items', 'transaction_id'],
        ['contract_events', 'transaction_id'],
      ];
  for (const [table, col] of refs) {
    if (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE ${col}=?`).get(id)
    )
      return true;
  }
  return false;
}
