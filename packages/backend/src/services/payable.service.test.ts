import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PayableService, monthlyDate } from './payable.service.js';
import { CardBillService } from './card-bill.service.js';
import { commitmentSchema, calendarDate } from '../validators/payable.schema.js';
import { exportBrazil, clearBrazil, restoreBrazil } from './brazil-backup.js';
let db: Database.Database, service: PayableService, cards: CardBillService;
const create = (extra: Record<string, unknown> = {}) =>
  service.create(
    1,
    commitmentSchema.parse({
      name: 'Casa',
      kind: 'installment',
      accountId: 1,
      categoryId: 1,
      amountCents: 10000,
      installments: 3,
      firstDue: '2026-01-31',
      ...extra,
    }),
  );
const rows = () =>
  service.list(1) as {
    id: number;
    number: number;
    amount_cents: number;
    paid_cents: number;
    due_date: string;
    cancelled: number;
  }[];
beforeEach(() => {
  db = new Database(':memory:');
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  db.pragma('foreign_keys=ON');
  db.exec(`INSERT INTO users(id,email,password_hash,name,created_at,updated_at) VALUES(1,'one@test','hash','One','now','now'),(2,'two@test','hash','Two','now','now');
 INSERT INTO accounts(id,user_id,name,type,currency,initial_balance,created_at,updated_at) VALUES(1,1,'Banco','Débito','BRL',10000,'now','now'),(2,1,'Cartão','Crédito','BRL',0,'now','now'),(3,2,'Outro','Débito','BRL',0,'now','now');
 INSERT INTO categories(id,user_id,name,type,is_system,created_at) VALUES(1,1,'Casa','Gasto',0,'now'),(2,2,'Outra','Gasto',0,'now');`);
  service = new PayableService(db);
  cards = new CardBillService(db);
});
afterEach(() => db.close());
describe('Brazilian payment workflows', () => {
  it('clamps dates without drifting, including leap years', () => {
    expect(monthlyDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(monthlyDate('2026-01-31', 2)).toBe('2026-03-31');
    expect(monthlyDate('2028-01-31', 1)).toBe('2028-02-29');
    expect(calendarDate.safeParse('2026-02-30').success).toBe(false);
  });
  it('migrates the real schema and distributes exact cents without moving cash', () => {
    create();
    expect(rows().map((r) => r.amount_cents)).toEqual([3334, 3333, 3333]);
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('starts existing contracts at the requested installment', () => {
    create({ kind: 'consortium', installments: 80, firstNumber: 18, amountCents: 85000 });
    expect(rows()).toHaveLength(63);
    expect(rows()[0]).toMatchObject({ number: 18, due_date: '2026-01-31', amount_cents: 85000 });
  });
  it('records partial payments atomically and retries without duplication', () => {
    create();
    const id = rows()[0]!.id;
    const p = { amountCents: 1000, date: '2026-01-30', key: randomUUID() };
    service.pay(1, id, p);
    service.pay(1, id, p);
    expect(rows()[0]!.paid_cents).toBe(1000);
    expect(db.prepare('SELECT SUM(amount) amount FROM transactions').get()).toEqual({ amount: 10 });
    expect(() => service.pay(1, id, { ...p, amountCents: 1001 })).toThrow();
    expect(() => service.pay(1, id, { ...p, key: randomUUID(), amountCents: 9999 })).toThrow();
  });
  it('protects ownership of accounts, categories, installments and payments', () => {
    expect(() => create({ accountId: 3 })).toThrow();
    expect(() => create({ categoryId: 2 })).toThrow();
    create();
    expect(() =>
      service.pay(2, rows()[0]!.id, { amountCents: 1, date: '2026-01-01', key: randomUUID() }),
    ).toThrow();
    expect(service.list(2)).toEqual([]);
  });
  it('reprices only unpaid installments and stops recurring forecasts', () => {
    const c = create({ kind: 'recurring' });
    const id = rows()[0]!.id;
    service.pay(1, id, { amountCents: 10000, date: '2026-01-01', key: randomUUID() });
    service.update(1, rows()[1]!.id, 12000, true);
    expect(rows()[0]!.amount_cents).toBe(10000);
    expect(rows()[1]!.amount_cents).toBe(12000);
    service.stop(1, c.id);
    service.list(1);
    expect(rows().filter((r) => !r.cancelled)).toHaveLength(1);
  });
  it('creates card purchases and pays a bill with one transfer, no extra expense', () => {
    cards.purchase(1, {
      accountId: 2,
      categoryId: 1,
      name: 'Sofá',
      amountCents: 10000,
      installments: 3,
      date: '2026-01-01',
      firstDue: '2026-02-10',
    });
    const bills = cards.list(1) as { id: number; total_cents: number }[];
    expect(bills.map((b) => b.total_cents)).toEqual([3334, 3333, 3333]);
    const p = { sourceAccountId: 1, amountCents: 3334, date: '2026-02-10', key: randomUUID() };
    cards.pay(1, bills[0]!.id, p);
    cards.pay(1, bills[0]!.id, p);
    expect(db.prepare('SELECT COUNT(*) n,SUM(amount) total FROM transactions').get()).toEqual({
      n: 3,
      total: 100,
    });
    expect(db.prepare('SELECT COUNT(*) n,SUM(amount) total FROM transfers').get()).toEqual({
      n: 1,
      total: 33.34,
    });
  });
  it('rolls back a purchase when any target statement is closed', () => {
    const input = {
      accountId: 2,
      categoryId: 1,
      name: 'Sofá',
      amountCents: 10000,
      installments: 3,
      date: '2026-01-01',
      firstDue: '2026-02-10',
    };
    cards.purchase(1, input);
    const bills = cards.list(1) as { id: number }[];
    cards.close(1, bills[1]!.id);
    expect(() => cards.purchase(1, input)).toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM card_purchases').get()).toEqual({ n: 1 });
    expect(cards.list(2)).toEqual([]);
  });
  it('exports and restores contracts and faturas with remapped links', () => {
    create();
    service.pay(1, rows()[0]!.id, { amountCents: 1000, date: '2026-01-01', key: randomUUID() });
    cards.purchase(1, {
      accountId: 2,
      categoryId: 1,
      name: 'Compra',
      amountCents: 200,
      installments: 1,
      date: '2026-01-01',
      firstDue: '2026-02-10',
    });
    const bill = (cards.list(1) as { id: number }[])[0]!;
    cards.pay(1, bill.id, {
      sourceAccountId: 1,
      amountCents: 200,
      date: '2026-02-10',
      key: randomUUID(),
    });
    const backup = exportBrazil(db, 1);
    clearBrazil(db, 1);
    expect(rows()).toEqual([]);
    restoreBrazil(
      db,
      1,
      backup,
      new Map([
        [1, 1],
        [2, 2],
      ]),
      new Map([[1, 1]]),
      new Map([
        [1, 1],
        [2, 2],
      ]),
      new Map([[1, 1]]),
    );
    expect(rows()[0]!.paid_cents).toBe(1000);
    expect(cards.list(1)).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
describe('contract events and migration', () => {
  it('records balances from statements without inferring principal from a payment', () => {
    const c = create({ kind: 'housing', amountCents: 80000, installments: 360 });
    service.event(1, c.id, {
      kind: 'balance',
      date: '2026-01-01',
      amountCents: 0,
      outstandingCents: 20000000,
      notes: 'Extrato',
      recordExpense: false,
    });
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 });
    service.event(1, c.id, {
      kind: 'amortization',
      date: '2026-02-01',
      amountCents: 500000,
      outstandingCents: 19500000,
      notes: 'Recursos próprios',
      recordExpense: true,
    });
    expect(db.prepare('SELECT SUM(amount) n FROM transactions').get()).toEqual({ n: 5000 });
    const contract = service.contract(1, c.id) as unknown as { details: string };
    expect(JSON.parse(contract.details).outstandingCents).toBe(19500000);
    expect(() => service.contract(2, c.id)).toThrow();
  });
  it('converts a monthly subscription once, disabling automatic charges', () => {
    db.exec(
      "INSERT INTO subscriptions(id,user_id,account_id,category_id,name,amount,cycle,start_date,next_payment_date,auto_charge,status,created_at,updated_at) VALUES(1,1,1,1,'Internet',100,'Mensual','2026-01-01','2026-12-01',1,'Activa','now','now')",
    );
    service.migrateSubscription(1, 1);
    service.migrateSubscription(1, 1);
    expect(db.prepare('SELECT COUNT(*) n FROM commitments').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status,auto_charge FROM subscriptions').get()).toEqual({
      status: 'Inactiva',
      auto_charge: 0,
    });
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 });
  });
  it('refunds card purchases without deleting historical expenses', () => {
    cards.purchase(1, {
      accountId: 2,
      categoryId: 1,
      name: 'Compra',
      amountCents: 101,
      installments: 2,
      date: '2026-01-01',
      firstDue: '2026-02-10',
    });
    cards.refund(1, 1);
    cards.refund(1, 1);
    expect(
      db
        .prepare(
          "SELECT SUM(CASE WHEN type='Gasto' THEN amount ELSE -amount END) total,COUNT(*) n FROM transactions",
        )
        .get(),
    ).toEqual({ total: 0, n: 4 });
    expect((cards.list(1) as { total_cents: number }[]).every((b) => b.total_cents === 0)).toBe(
      true,
    );
  });
  it('imports ongoing card installments without creating the historical ones', () => {
    cards.purchase(1, {
      accountId: 2,
      categoryId: 1,
      name: 'Compra antiga',
      amountCents: 10000,
      installments: 10,
      firstNumber: 8,
      date: '2026-01-01',
      firstDue: '2026-11-10',
    });
    expect(
      db
        .prepare('SELECT SUM(amount_cents) total,MIN(number) first,COUNT(*) n FROM card_bill_items')
        .get(),
    ).toEqual({ total: 3000, first: 8, n: 3 });
  });
});

describe('complete credit card lifecycle', () => {
  const buy = (extra: Record<string, unknown> = {}) =>
    cards.purchase(1, {
      accountId: 2,
      categoryId: 1,
      name: 'Celular',
      amountCents: 40000,
      installments: 4,
      date: '2026-01-01',
      firstDue: '2026-01-10',
      ...extra,
    });
  const bills = () =>
    cards.list(1) as {
      id: number;
      due_date: string;
      total_cents: number;
      paid_cents: number;
      closed: number;
    }[];
  const debt = () => {
    const row = db
      .prepare(
        "SELECT -COALESCE((SELECT SUM(CASE WHEN type='Gasto' THEN amount ELSE -amount END) FROM transactions WHERE account_id=2),0)+COALESCE((SELECT SUM(amount) FROM transfers WHERE destination_account_id=2),0)-COALESCE((SELECT SUM(amount) FROM transfers WHERE source_account_id=2),0) balance",
      )
      .get() as { balance: number };
    return Math.round(row.balance * 100);
  };
  it('keeps the configured due day after a short month', () => {
    db.exec('UPDATE accounts SET payment_due_day=31 WHERE id=2');
    buy({ firstDue: '2026-02-28' });
    expect(bills().map((b) => b.due_date)).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });
  it('does not repeat a purchase when a network response is lost', () => {
    const key = randomUUID();
    const a = buy({ key });
    const b = buy({ key });
    expect(a).toEqual(b);
    expect(debt()).toBe(-40000);
    expect(() => buy({ key, amountCents: 50000 })).toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM card_purchases').get()).toEqual({ n: 1 });
  });
  it('credits a partial refund on a new statement after the original was paid', () => {
    buy();
    const original = bills()[0]!;
    cards.close(1, original.id);
    cards.pay(1, original.id, {
      sourceAccountId: 1,
      amountCents: 10000,
      date: '2026-01-10',
      key: randomUUID(),
    });
    const request = { amountCents: 5000, dueDate: '2026-05-10', key: randomUUID() };
    cards.refundToBill(1, 1, request);
    cards.refundToBill(1, 1, request);
    expect(bills()[0]).toMatchObject({ total_cents: 10000, paid_cents: 10000, closed: 1 });
    expect(bills().at(-1)).toMatchObject({ total_cents: -5000, paid_cents: 0 });
    expect(debt()).toBe(-25000);
    expect(() => cards.refundToBill(1, 1, { ...request, amountCents: 6000 })).toThrow();
  });
  it('bounds total refunds and protects ownership and closed target cycles', () => {
    buy();
    cards.close(1, bills()[0]!.id);
    expect(() =>
      cards.refundToBill(1, 1, { amountCents: 100, dueDate: '2026-01-10', key: randomUUID() }),
    ).toThrow();
    cards.refundToBill(1, 1, { amountCents: 40000, dueDate: '2026-05-10', key: randomUUID() });
    expect(() =>
      cards.refundToBill(1, 1, { amountCents: 1, dueDate: '2026-05-10', key: randomUUID() }),
    ).toThrow();
    expect(() =>
      cards.refundToBill(2, 1, { amountCents: 1, dueDate: '2026-05-10', key: randomUUID() }),
    ).toThrow();
    expect(debt()).toBe(0);
  });
  it('undoes a payment once with an inverse transfer and retains history', () => {
    buy();
    const bill = bills()[0]!;
    const request = {
      sourceAccountId: 1,
      amountCents: 10000,
      date: '2026-01-10',
      key: randomUUID(),
    };
    cards.pay(1, bill.id, request);
    const history = cards.history(1, bill.id) as { payments: { id: number }[] };
    expect(() => cards.undoPayment(1, bill.id, history.payments[0]!.id, '2026-01-09')).toThrow();
    cards.undoPayment(1, bill.id, history.payments[0]!.id, '2026-01-11');
    cards.undoPayment(1, bill.id, history.payments[0]!.id, '2026-01-11');
    expect(bills()[0]!.paid_cents).toBe(0);
    expect(debt()).toBe(-40000);
    expect(db.prepare('SELECT COUNT(*) n FROM transfers').get()).toEqual({ n: 2 });
    expect(() => cards.undoPayment(2, bill.id, history.payments[0]!.id, '2026-01-11')).toThrow();
    cards.pay(1, bill.id, request);
    expect(debt()).toBe(-40000);
  });
  it('carries only the unpaid balance without another expense or transfer', () => {
    buy();
    const original = bills()[0]!;
    cards.pay(1, original.id, {
      sourceAccountId: 1,
      amountCents: 3000,
      date: '2026-01-10',
      key: randomUUID(),
    });
    const request = { dueDate: '2026-02-10', key: randomUUID() };
    cards.carry(1, original.id, request);
    cards.carry(1, original.id, request);
    expect(bills()[0]).toMatchObject({ total_cents: 3000, paid_cents: 3000, closed: 1 });
    expect(bills()[1]!.total_cents).toBe(17000);
    expect(debt()).toBe(-37000);
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 4 });
    expect(db.prepare('SELECT COUNT(*) n FROM transfers').get()).toEqual({ n: 1 });
  });
  it('carries a credit and can return it to its original statement', () => {
    buy();
    cards.refundToBill(1, 1, { amountCents: 5000, dueDate: '2026-05-10', key: randomUUID() });
    const source = bills().at(-1)!;
    const movement = cards.carry(1, source.id, { dueDate: '2026-06-10', key: randomUUID() });
    expect(bills().at(-1)!.total_cents).toBe(-5000);
    expect(debt()).toBe(-35000);
    cards.undoCarry(1, source.id, movement.movementId);
    cards.undoCarry(1, source.id, movement.movementId);
    expect(bills().find((b) => b.id === source.id)!.total_cents).toBe(-5000);
    expect(bills().at(-1)!.total_cents).toBe(0);
    expect(debt()).toBe(-35000);
  });
  it('blocks reversing a carried balance after its target has been paid', () => {
    buy();
    const source = bills()[0]!;
    const m = cards.carry(1, source.id, { dueDate: '2026-02-10', key: randomUUID() });
    cards.pay(1, m.billId, {
      sourceAccountId: 1,
      amountCents: 100,
      date: '2026-02-10',
      key: randomUUID(),
    });
    expect(() => cards.undoCarry(1, source.id, m.movementId)).toThrow();
  });
  it('anticipates future installments and a bank-provided discount atomically', () => {
    buy();
    const request = { fromNumber: 2, dueDate: '2026-01-10', discountCents: 500, key: randomUUID() };
    const result = cards.anticipate(1, 1, request);
    cards.anticipate(1, 1, request);
    expect(result).toMatchObject({ count: 3, amountCents: 29500 });
    expect(bills()[0]!.total_cents).toBe(39500);
    expect(
      bills()
        .slice(1)
        .every((b) => b.total_cents === 0),
    ).toBe(true);
    expect(debt()).toBe(-39500);
    expect(db.prepare('SELECT COUNT(DISTINCT date) n FROM transactions').get()).toEqual({ n: 1 });
  });
  it('rejects anticipation from paid/closed cycles without partial changes', () => {
    buy();
    cards.close(1, bills()[2]!.id);
    expect(() =>
      cards.anticipate(1, 1, {
        fromNumber: 2,
        dueDate: '2026-01-10',
        discountCents: 0,
        key: randomUUID(),
      }),
    ).toThrow();
    expect(bills().map((b) => b.total_cents)).toEqual([10000, 10000, 10000, 10000]);
    cards.reopen(1, bills()[2]!.id);
    cards.anticipate(1, 1, {
      fromNumber: 2,
      dueDate: '2026-01-10',
      discountCents: 0,
      key: randomUUID(),
    });
    expect(bills()[0]!.total_cents).toBe(40000);
  });
  it('restores refunds, reversals and carried balances with foreign keys intact', () => {
    buy();
    const source = bills()[0]!;
    cards.pay(1, source.id, {
      sourceAccountId: 1,
      amountCents: 1000,
      date: '2026-01-10',
      key: randomUUID(),
    });
    const history = cards.history(1, source.id) as { payments: { id: number }[] };
    cards.undoPayment(1, source.id, history.payments[0]!.id, '2026-01-11');
    cards.carry(1, source.id, { dueDate: '2026-02-10', key: randomUUID() });
    cards.refundToBill(1, 1, { amountCents: 500, dueDate: '2026-02-10', key: randomUUID() });
    const before = bills().map((b) => ({
      date: b.due_date,
      total: b.total_cents,
      paid: b.paid_cents,
    }));
    const backup = exportBrazil(db, 1);
    clearBrazil(db, 1);
    const transactions = new Map(
      (db.prepare('SELECT id FROM transactions').all() as { id: number }[]).map((t) => [
        t.id,
        t.id,
      ]),
    );
    restoreBrazil(
      db,
      1,
      backup,
      new Map([
        [1, 1],
        [2, 2],
      ]),
      new Map([[1, 1]]),
      transactions,
      new Map([
        [1, 1],
        [2, 2],
      ]),
    );
    expect(
      bills().map((b) => ({ date: b.due_date, total: b.total_cents, paid: b.paid_cents })),
    ).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('linking existing card transactions', () => {
  it('reuses imported transactions without repeating the expense or changing the account balance', () => {
    db.exec(
      "INSERT INTO transactions(id,user_id,account_id,category_id,name,amount,type,date,created_at,updated_at) VALUES(1,1,2,1,'Importada',100,'Gasto','2026-01-01','now','now')",
    );
    expect(cards.unassigned(1, 2)).toHaveLength(1);
    expect(cards.unassigned(2, 2)).toEqual([]);
    const input = { dueDate: '2026-02-10', key: randomUUID() };
    cards.assign(1, 1, input);
    cards.assign(1, 1, input);
    expect(cards.unassigned(1, 2)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n,SUM(amount) total FROM transactions').get()).toEqual({
      n: 1,
      total: 100,
    });
    expect((cards.list(1) as { total_cents: number }[])[0]!.total_cents).toBe(10000);
    expect(() => cards.assign(1, 1, { ...input, key: randomUUID() })).toThrow();
    expect(() => cards.assign(2, 1, { ...input, key: randomUUID() })).toThrow();
  });
});

describe('recurring income', () => {
  const salary = () => {
    db.exec(
      "INSERT INTO categories(id,user_id,name,type,is_system,created_at) VALUES(3,1,'Salário','Ingreso',0,'now')",
    );
    return create({
      direction: 'income',
      kind: 'recurring',
      categoryId: 3,
      name: 'Salário',
      amountCents: 500000,
      firstDue: '2026-11-05',
    });
  };
  it('forecasts monthly salary without crediting the bank before confirmation', () => {
    salary();
    const list = service.list(1) as { direction: string; due_date: string }[];
    expect(list.length).toBeGreaterThanOrEqual(24);
    expect(list.every((r) => r.direction === 'income')).toBe(true);
    expect(list.slice(0, 3).map((r) => r.due_date)).toEqual([
      '2026-11-05',
      '2026-12-05',
      '2027-01-05',
    ]);
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 });
  });
  it('records receipt as income, including partial receipts and retries', () => {
    salary();
    const id = rows()[0]!.id;
    const input = { amountCents: 300000, date: '2026-11-05', key: randomUUID() };
    service.pay(1, id, input, 'income');
    service.pay(1, id, input, 'income');
    expect(db.prepare('SELECT type,amount,account_id FROM transactions').get()).toEqual({
      type: 'Ingreso',
      amount: 3000,
      account_id: 1,
    });
    expect(rows()[0]!.paid_cents).toBe(300000);
    expect(() =>
      service.pay(1, id, { ...input, key: randomUUID(), amountCents: 250000 }, 'income'),
    ).toThrow();
    expect(() => service.pay(1, id, { ...input, key: randomUUID() }, 'expense')).toThrow();
    service.pay(1, id, { ...input, key: randomUUID(), amountCents: 200000 }, 'income');
    expect(rows()[0]!.paid_cents).toBe(500000);
  });
  it('rejects expense categories, credit accounts and financing kinds for income', () => {
    expect(() => create({ direction: 'income', kind: 'recurring' })).toThrow();
    expect(
      commitmentSchema.safeParse({
        direction: 'income',
        kind: 'housing',
        name: 'Inválida',
        amountCents: 100,
        installments: 1,
        accountId: 1,
        categoryId: 1,
        firstDue: '2026-11-05',
      }).success,
    ).toBe(false);
    salary();
    expect(() =>
      create({ direction: 'income', kind: 'recurring', categoryId: 3, accountId: 2 }),
    ).toThrow();
  });
  it('preserves received amounts when adjusting the following salaries', () => {
    const c = salary();
    service.pay(
      1,
      rows()[0]!.id,
      { amountCents: 500000, date: '2026-11-05', key: randomUUID() },
      'income',
    );
    service.update(1, rows()[1]!.id, 550000, true);
    expect(rows()[0]!.amount_cents).toBe(500000);
    expect(rows()[1]!.amount_cents).toBe(550000);
    service.stop(1, c.id);
    expect(rows().filter((r) => !r.cancelled)).toHaveLength(1);
  });
  it('restores old custom backups as expenses and retains income direction in new backups', () => {
    salary();
    create();
    const backup = exportBrazil(db, 1);
    for (const row of backup.commitments ?? [])
      if (row['direction'] === 'expense') delete row['direction'];
    clearBrazil(db, 1);
    restoreBrazil(
      db,
      1,
      backup,
      new Map([[1, 1]]),
      new Map([
        [1, 1],
        [3, 3],
      ]),
      new Map(),
      new Map(),
    );
    const directions = db.prepare('SELECT direction FROM commitments ORDER BY id').all();
    expect(directions).toEqual([{ direction: 'income' }, { direction: 'expense' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
