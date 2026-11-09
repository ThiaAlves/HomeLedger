import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
const tables = [
  'commitments',
  'payable_installments',
  'payable_payments',
  'contract_events',
  'card_bills',
  'card_purchases',
  'card_bill_items',
  'card_bill_payments',
  'card_bill_movements',
  'card_requests',
] as const;
type Row = Record<string, string | number | null>;
export type BrazilBackup = Partial<Record<(typeof tables)[number], Row[]>>;
function exists(db: Database.Database, table: string) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
const ownership: Record<(typeof tables)[number], string> = {
  contract_events: 'commitment_id IN (SELECT id FROM commitments WHERE user_id=?)',
  commitments: 'user_id=?',
  payable_installments: 'commitment_id IN (SELECT id FROM commitments WHERE user_id=?)',
  payable_payments:
    'installment_id IN (SELECT i.id FROM payable_installments i JOIN commitments c ON c.id=i.commitment_id WHERE c.user_id=?)',
  card_bills: 'user_id=?',
  card_requests: 'user_id=?',
  card_bill_movements: 'from_bill_id IN (SELECT id FROM card_bills WHERE user_id=?)',
  card_purchases: 'user_id=?',
  card_bill_items: 'bill_id IN (SELECT id FROM card_bills WHERE user_id=?)',
  card_bill_payments: 'bill_id IN (SELECT id FROM card_bills WHERE user_id=?)',
};
export function exportBrazil(db: Database.Database, userId: number): BrazilBackup {
  const result: BrazilBackup = {};
  for (const table of tables)
    if (exists(db, table))
      result[table] = db
        .prepare(`SELECT * FROM ${table} WHERE ${ownership[table]}`)
        .all(userId) as Row[];
  return result;
}
export function clearBrazil(db: Database.Database, userId: number) {
  for (const table of [...tables].reverse())
    if (exists(db, table)) db.prepare(`DELETE FROM ${table} WHERE ${ownership[table]}`).run(userId);
}
export function restoreBrazil(
  db: Database.Database,
  userId: number,
  data: BrazilBackup,
  accounts: Map<number, number>,
  categories: Map<number, number>,
  transactions: Map<number, number>,
  transfers: Map<number, number>,
) {
  const maps: Record<string, Map<number, number>> = {
    account_id: accounts,
    category_id: categories,
    transaction_id: transactions,
    transfer_id: transfers,
    reversal_transfer_id: transfers,
    commitment_id: new Map(),
    installment_id: new Map(),
    bill_id: new Map(),
    purchase_id: new Map(),
  };
  const ids: Record<string, string> = {
    commitments: 'commitment_id',
    payable_installments: 'installment_id',
    card_bills: 'bill_id',
    card_purchases: 'purchase_id',
  };
  for (const table of tables) {
    const rows = data[table] ?? [];
    if (!rows.length) continue;
    if (!exists(db, table)) throw new Error('Migração brasileira ausente');
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'id');
    for (const row of rows) {
      const values = columns.map((col) => {
        if (col === 'user_id') return userId;
        if (col === 'source_subscription_id') return null;
        if (col === 'payment_key' || col === 'event_key' || col === 'operation_key')
          return randomUUID();
        const mapping =
          maps[col] ??
          (col === 'from_bill_id' || col === 'to_bill_id' ? maps['bill_id'] : undefined);
        if (mapping) {
          if (row[col] == null) return null;
          const mapped = mapping.get(Number(row[col]));
          if (mapped == null) throw new Error(`Referência ausente no backup: ${table}.${col}`);
          return mapped;
        }
        return row[col] ?? null;
      });
      const result = db
        .prepare(
          `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        )
        .run(...values);
      const mapKey = ids[table];
      if (mapKey) maps[mapKey]?.set(Number(row['id']), Number(result.lastInsertRowid));
    }
  }
}
