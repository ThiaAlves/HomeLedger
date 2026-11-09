import type Database from 'better-sqlite3';
import { getSqlite } from '../db/connection.js';
import type { CommitmentInput } from '../validators/payable.schema.js';

export class PayableError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
/** Uses the original anchor day, so Jan 31 → Feb 28 → Mar 31. */
export function monthlyDate(anchor: string, offset: number, day?: number): string {
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day ?? d, last));
  return date.toISOString().slice(0, 10);
}
export function installmentCents(total: number, count: number, index: number): number {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}
interface Commitment {
  id: number;
  user_id: number;
  account_id: number;
  category_id: number;
  name: string;
  kind: string;
  direction: 'expense' | 'income';
  amount_cents: number;
  total_installments: number;
  first_number: number;
  first_due: string;
  active: number;
}
interface Due {
  id: number;
  commitment_id: number;
  number: number;
  amount_cents: number;
  cancelled: number;
  paid_cents: number;
}
export class PayableService {
  constructor(private db: Database.Database = getSqlite()) {}
  private commitment(userId: number, id: number): Commitment {
    const row = this.db
      .prepare('SELECT * FROM commitments WHERE id=? AND user_id=?')
      .get(id, userId) as Commitment | undefined;
    if (!row) throw new PayableError('Compromisso não encontrado', 404);
    return row;
  }
  private due(userId: number, id: number): Due {
    const row = this.db
      .prepare(
        `SELECT i.*, COALESCE((SELECT SUM(amount_cents) FROM payable_payments WHERE installment_id=i.id),0) paid_cents FROM payable_installments i JOIN commitments c ON c.id=i.commitment_id WHERE i.id=? AND c.user_id=?`,
      )
      .get(id, userId) as Due | undefined;
    if (!row) throw new PayableError('Parcela não encontrada', 404);
    return row;
  }
  private extend(c: Commitment, count: number) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO payable_installments(commitment_id,number,due_date,amount_cents) VALUES(?,?,?,?)',
    );
    for (let n = c.first_number; n <= count; n++)
      insert.run(
        c.id,
        n,
        monthlyDate(c.first_due, n - c.first_number),
        c.kind === 'installment'
          ? installmentCents(c.amount_cents, c.total_installments, n - 1)
          : c.amount_cents,
      );
  }
  create(userId: number, input: CommitmentInput) {
    return this.db.transaction(() => {
      const account = this.db
        .prepare('SELECT type FROM accounts WHERE id=? AND user_id=?')
        .get(input.accountId, userId) as { type: string } | undefined;
      if (!account) throw new PayableError('Conta não encontrada');
      if (account.type === 'Crédito')
        throw new PayableError(
          'Use uma conta bancária ou dinheiro para contas a pagar. Compras no cartão serão controladas pelas faturas.',
        );
      const category = this.db
        .prepare('SELECT type FROM categories WHERE id=? AND user_id=?')
        .get(input.categoryId, userId) as { type: string } | undefined;
      if (!category) throw new PayableError('Categoria não encontrada');
      if (
        (input.direction === 'income' && category.type === 'Gasto') ||
        (input.direction === 'expense' && category.type === 'Ingreso')
      )
        throw new PayableError('A categoria deve corresponder ao tipo de movimentação');
      const result = this.db
        .prepare(
          `INSERT INTO commitments(user_id,account_id,category_id,name,kind,amount_cents,total_installments,first_number,first_due,details,created_at,direction) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          userId,
          input.accountId,
          input.categoryId,
          input.name,
          input.kind,
          input.amountCents,
          input.installments,
          input.firstNumber,
          input.firstDue,
          JSON.stringify(input.details),
          new Date().toISOString(),
          input.direction,
        );
      const c = this.commitment(userId, Number(result.lastInsertRowid));
      this.extend(c, c.kind === 'recurring' ? c.first_number + 23 : c.total_installments);
      return c;
    })();
  }
  list(userId: number) {
    // Keep an ongoing rolling forecast; never create financial transactions here.
    this.db.transaction(() => {
      const ongoing = this.db
        .prepare("SELECT * FROM commitments WHERE user_id=? AND kind='recurring' AND active=1")
        .all(userId) as Commitment[];
      for (const c of ongoing) {
        const today = new Date();
        const months = Math.max(
          0,
          (today.getUTCFullYear() - Number(c.first_due.slice(0, 4))) * 12 +
            today.getUTCMonth() +
            1 -
            Number(c.first_due.slice(5, 7)),
        );
        this.extend(c, c.first_number + months + 23);
      }
    })();
    return this.db
      .prepare(
        `SELECT i.*,c.name,c.kind,c.direction,c.total_installments,c.account_id,c.category_id,c.details,a.name account_name, COALESCE((SELECT SUM(p.amount_cents) FROM payable_payments p WHERE p.installment_id=i.id),0) paid_cents FROM payable_installments i JOIN commitments c ON c.id=i.commitment_id JOIN accounts a ON a.id=c.account_id WHERE c.user_id=? ORDER BY i.due_date,i.id`,
      )
      .all(userId);
  }
  pay(
    userId: number,
    id: number,
    input: { amountCents: number; date: string; key: string },
    expectedDirection?: 'income' | 'expense',
  ) {
    return this.db.transaction(() => {
      const due = this.due(userId, id);
      const c = this.commitment(userId, due.commitment_id);
      if (expectedDirection && c.direction !== expectedDirection)
        throw new PayableError('Operação incompatível com o tipo do compromisso');
      const previous = this.db
        .prepare('SELECT * FROM payable_payments WHERE payment_key=?')
        .get(input.key) as
        { installment_id: number; amount_cents: number; date: string } | undefined;
      if (previous) {
        if (
          previous.installment_id !== id ||
          previous.amount_cents !== input.amountCents ||
          previous.date !== input.date
        )
          throw new PayableError('Identificador de pagamento já utilizado', 409);
        return previous;
      }
      if (due.cancelled || input.amountCents > due.amount_cents - due.paid_cents)
        throw new PayableError('Valor maior que o saldo em aberto ou parcela cancelada', 409);
      const now = new Date().toISOString();
      const tx = this.db
        .prepare(
          `INSERT INTO transactions(user_id,account_id,category_id,name,amount,type,date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          userId,
          c.account_id,
          c.category_id,
          `${c.name} — ${due.number}`,
          input.amountCents / 100,
          c.direction === 'income' ? 'Ingreso' : 'Gasto',
          input.date,
          now,
          now,
        );
      const p = this.db
        .prepare(
          'INSERT INTO payable_payments(installment_id,transaction_id,amount_cents,payment_key,date) VALUES(?,?,?,?,?)',
        )
        .run(id, Number(tx.lastInsertRowid), input.amountCents, input.key, input.date);
      return { id: Number(p.lastInsertRowid), transactionId: Number(tx.lastInsertRowid) };
    })();
  }
  update(userId: number, id: number, amount: number, future: boolean) {
    return this.db.transaction(() => {
      const due = this.due(userId, id);
      if (due.paid_cents || due.cancelled)
        throw new PayableError('Somente parcelas em aberto podem ser alteradas', 409);
      this.db
        .prepare(
          `UPDATE payable_installments SET amount_cents=? WHERE commitment_id=? AND ${future ? 'number>=?' : 'id=?'} AND cancelled=0 AND NOT EXISTS(SELECT 1 FROM payable_payments p WHERE p.installment_id=payable_installments.id)`,
        )
        .run(amount, due.commitment_id, future ? due.number : id);
      if (future)
        this.db
          .prepare('UPDATE commitments SET amount_cents=? WHERE id=? AND kind!=?')
          .run(amount, due.commitment_id, 'installment');
    })();
  }
  cancel(userId: number, id: number) {
    return this.db.transaction(() => {
      const due = this.due(userId, id);
      if (due.paid_cents)
        throw new PayableError('Parcela com pagamento não pode ser cancelada', 409);
      this.db.prepare('UPDATE payable_installments SET cancelled=1 WHERE id=?').run(id);
    })();
  }
  stop(userId: number, id: number) {
    return this.db.transaction(() => {
      this.commitment(userId, id);
      this.db.prepare('UPDATE commitments SET active=0 WHERE id=?').run(id);
      this.db
        .prepare(
          'UPDATE payable_installments SET cancelled=1 WHERE commitment_id=? AND NOT EXISTS(SELECT 1 FROM payable_payments p WHERE p.installment_id=payable_installments.id)',
        )
        .run(id);
    })();
  }
  migrateSubscription(userId: number, id: number) {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM commitments WHERE user_id=? AND source_subscription_id=?')
        .get(userId, id);
      if (existing) return existing;
      const sub = this.db
        .prepare("SELECT * FROM subscriptions WHERE id=? AND user_id=? AND status='Activa'")
        .get(id, userId) as
        | {
            account_id: number;
            category_id: number;
            name: string;
            amount: number;
            cycle: string;
            next_payment_date: string;
          }
        | undefined;
      if (!sub || sub.cycle !== 'Mensual')
        throw new PayableError('Selecione uma assinatura mensal ativa');
      const c = this.create(userId, {
        name: sub.name,
        accountId: sub.account_id,
        categoryId: sub.category_id,
        kind: 'recurring',
        direction: 'expense',
        amountCents: Math.round(sub.amount * 100),
        installments: 1,
        firstNumber: 1,
        firstDue: sub.next_payment_date,
        details: {},
      });
      this.db.prepare('UPDATE commitments SET source_subscription_id=? WHERE id=?').run(id, c.id);
      this.db
        .prepare("UPDATE subscriptions SET status='Inactiva',auto_charge=0 WHERE id=?")
        .run(id);
      return c;
    })();
  }
  contract(userId: number, id: number) {
    const c = this.commitment(userId, id);
    return {
      ...c,
      events: this.db
        .prepare('SELECT * FROM contract_events WHERE commitment_id=? ORDER BY date,id')
        .all(id),
    };
  }
  event(
    userId: number,
    id: number,
    input: {
      kind: string;
      date: string;
      amountCents: number;
      outstandingCents?: number;
      notes: string;
      recordExpense: boolean;
      key?: string;
    },
  ) {
    return this.db.transaction(() => {
      const c = this.commitment(userId, id);
      if (!['housing', 'consortium'].includes(c.kind))
        throw new PayableError('Compromisso não é um contrato');
      if (input.key) {
        const previous = this.db
          .prepare('SELECT * FROM contract_events WHERE event_key=?')
          .get(input.key) as
          | {
              commitment_id: number;
              kind: string;
              date: string;
              amount_cents: number;
              outstanding_cents: number | null;
              notes: string;
              transaction_id: number | null;
            }
          | undefined;
        if (previous) {
          if (
            previous.commitment_id !== id ||
            previous.kind !== input.kind ||
            previous.date !== input.date ||
            previous.amount_cents !== input.amountCents ||
            previous.outstanding_cents !== (input.outstandingCents ?? null) ||
            previous.notes !== input.notes ||
            !!previous.transaction_id !== input.recordExpense
          )
            throw new PayableError('Identificador de evento já utilizado', 409);
          return;
        }
      }
      let tx: number | null = null;
      if (input.recordExpense) {
        if (!input.amountCents) throw new PayableError('Informe o valor pago');
        const now = new Date().toISOString();
        tx = Number(
          this.db
            .prepare(
              "INSERT INTO transactions(user_id,account_id,category_id,name,amount,type,date,created_at,updated_at) VALUES(?,?,?,?,?,'Gasto',?,?,?)",
            )
            .run(
              userId,
              c.account_id,
              c.category_id,
              c.name + ' — ' + input.kind,
              input.amountCents / 100,
              input.date,
              now,
              now,
            ).lastInsertRowid,
        );
      }
      this.db
        .prepare(
          'INSERT INTO contract_events(commitment_id,kind,event_key,date,amount_cents,outstanding_cents,notes,transaction_id) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.kind,
          input.key ?? null,
          input.date,
          input.amountCents,
          input.outstandingCents ?? null,
          input.notes,
          tx,
        );
      // Outstanding balance is explicitly supplied from a statement, never inferred from total payments.
      if (input.outstandingCents !== undefined) {
        const row = this.db.prepare('SELECT details FROM commitments WHERE id=?').get(id) as {
          details: string;
        };
        const details = JSON.parse(row.details);
        details.outstandingCents = input.outstandingCents;
        details.referenceDate = input.date;
        this.db
          .prepare('UPDATE commitments SET details=? WHERE id=?')
          .run(JSON.stringify(details), id);
      }
    })();
  }
}
