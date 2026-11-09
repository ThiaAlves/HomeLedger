import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqlite } from '../db/connection.js';
import { monthlyDate, installmentCents, PayableError } from './payable.service.js';
// Moving an obligation/credit between statements never creates another expense.
const totalSql = `COALESCE((SELECT SUM(amount_cents) FROM card_bill_items WHERE bill_id=b.id),0)
 + COALESCE((SELECT SUM(amount_cents) FROM card_bill_movements WHERE to_bill_id=b.id AND voided=0),0)
 - COALESCE((SELECT SUM(amount_cents) FROM card_bill_movements WHERE from_bill_id=b.id AND voided=0),0)`;
const paidSql =
  'COALESCE((SELECT SUM(amount_cents) FROM card_bill_payments WHERE bill_id=b.id AND reversal_transfer_id IS NULL),0)';
export class CardBillService {
  constructor(private db: Database.Database = getSqlite()) {}
  list(userId: number) {
    return this.db
      .prepare(
        `SELECT b.*,a.name account_name,${totalSql} total_cents,${paidSql} paid_cents FROM card_bills b JOIN accounts a ON a.id=b.account_id WHERE b.user_id=? ORDER BY due_date`,
      )
      .all(userId);
  }
  items(userId: number, id: number) {
    this.bill(userId, id);
    return this.db
      .prepare(
        'SELECT i.*,p.name,p.installments,p.purchase_date,(SELECT SUM(amount_cents) FROM card_bill_items WHERE purchase_id=p.id) refundable_cents FROM card_bill_items i JOIN card_purchases p ON p.id=i.purchase_id WHERE i.bill_id=?',
      )
      .all(id);
  }
  private bill(userId: number, id: number) {
    const b = this.db
      .prepare('SELECT * FROM card_bills WHERE id=? AND user_id=?')
      .get(id, userId) as { id: number; account_id: number; closed: number } | undefined;
    if (!b) throw new PayableError('Fatura não encontrada', 404);
    return b;
  }
  purchase(
    userId: number,
    input: {
      accountId: number;
      categoryId: number;
      name: string;
      amountCents: number;
      installments: number;
      firstNumber?: number;
      date: string;
      firstDue: string;
      key?: string;
    },
  ) {
    return this.request(userId, input.key, 'purchase', input, () => {
      const account = this.db
        .prepare(
          "SELECT currency,payment_due_day FROM accounts WHERE id=? AND user_id=? AND status='Activo' AND type='Crédito'",
        )
        .get(input.accountId, userId) as
        { currency: string; payment_due_day: number | null } | undefined;
      if (
        !account ||
        !this.db
          .prepare('SELECT id FROM categories WHERE id=? AND user_id=?')
          .get(input.categoryId, userId)
      )
        throw new PayableError('Cartão ou categoria inválidos');
      const now = new Date().toISOString();
      const p = this.db
        .prepare(
          'INSERT INTO card_purchases(user_id,account_id,name,total_cents,installments,purchase_date) VALUES(?,?,?,?,?,?)',
        )
        .run(
          userId,
          input.accountId,
          input.name,
          input.amountCents,
          input.installments,
          input.date,
        );
      const purchaseId = Number(p.lastInsertRowid);
      const firstDay = Number(input.firstDue.slice(8, 10));
      const monthLast = new Date(
        Date.UTC(Number(input.firstDue.slice(0, 4)), Number(input.firstDue.slice(5, 7)), 0),
      ).getUTCDate();
      const anchorDay =
        account.payment_due_day && Math.min(account.payment_due_day, monthLast) === firstDay
          ? account.payment_due_day
          : firstDay;
      for (let i = (input.firstNumber ?? 1) - 1; i < input.installments; i++) {
        const due = monthlyDate(input.firstDue, i - ((input.firstNumber ?? 1) - 1), anchorDay);
        this.db
          .prepare('INSERT OR IGNORE INTO card_bills(user_id,account_id,due_date) VALUES(?,?,?)')
          .run(userId, input.accountId, due);
        const bill = this.db
          .prepare('SELECT id,closed FROM card_bills WHERE account_id=? AND due_date=?')
          .get(input.accountId, due) as { id: number; closed: number };
        if (bill.closed) throw new PayableError('A fatura selecionada já está fechada', 409);
        const amount = installmentCents(input.amountCents, input.installments, i);
        // Future-dated expenses commit the full credit balance; reports distribute by month.
        const tx = this.db
          .prepare(
            `INSERT INTO transactions(user_id,account_id,category_id,name,amount,type,date,created_at,updated_at) VALUES(?,?,?,?,?,'Gasto',?,?,?)`,
          )
          .run(
            userId,
            input.accountId,
            input.categoryId,
            `${input.name} — ${i + 1}/${input.installments}`,
            amount / 100,
            due,
            now,
            now,
          );
        this.db
          .prepare(
            'INSERT INTO card_bill_items(bill_id,purchase_id,transaction_id,number,amount_cents) VALUES(?,?,?,?,?)',
          )
          .run(bill.id, purchaseId, Number(tx.lastInsertRowid), i + 1, amount);
      }
      return { purchaseId };
    });
  }
  close(userId: number, id: number) {
    this.bill(userId, id);
    this.db.prepare('UPDATE card_bills SET closed=1 WHERE id=?').run(id);
  }
  pay(
    userId: number,
    id: number,
    input: { sourceAccountId: number; amountCents: number; date: string; key: string },
  ) {
    return this.db.transaction(() => {
      const b = this.bill(userId, id);
      const source = this.db
        .prepare(
          "SELECT currency FROM accounts WHERE id=? AND user_id=? AND status='Activo' AND type!='Crédito'",
        )
        .get(input.sourceAccountId, userId) as { currency: string } | undefined;
      const target = this.db
        .prepare('SELECT currency FROM accounts WHERE id=?')
        .get(b.account_id) as { currency: string };
      if (!source || source.currency !== target.currency)
        throw new PayableError('Selecione uma conta de pagamento na mesma moeda do cartão');
      const prev = this.db
        .prepare('SELECT * FROM card_bill_payments WHERE payment_key=?')
        .get(input.key) as
        { bill_id: number; amount_cents: number; date: string; transfer_id: number } | undefined;
      if (prev) {
        const transfer = this.db
          .prepare('SELECT source_account_id FROM transfers WHERE id=?')
          .get(prev.transfer_id) as { source_account_id: number };
        if (
          prev.bill_id !== id ||
          prev.amount_cents !== input.amountCents ||
          prev.date !== input.date ||
          transfer.source_account_id !== input.sourceAccountId
        )
          throw new PayableError('Identificador já utilizado', 409);
        return prev;
      }
      const row = this.db
        .prepare(`SELECT ${totalSql}-${paidSql} remaining FROM card_bills b WHERE b.id=?`)
        .get(id) as { remaining: number };
      if (input.amountCents > row.remaining)
        throw new PayableError('Pagamento maior que o saldo da fatura', 409);
      const funds = this.db
        .prepare(
          `SELECT initial_balance+COALESCE((SELECT SUM(CASE WHEN type='Ingreso' THEN amount ELSE -amount END) FROM transactions WHERE account_id=a.id),0)+COALESCE((SELECT SUM(COALESCE(destination_amount,amount)) FROM transfers WHERE destination_account_id=a.id),0)-COALESCE((SELECT SUM(amount) FROM transfers WHERE source_account_id=a.id),0) balance FROM accounts a WHERE id=?`,
        )
        .get(input.sourceAccountId) as { balance: number };
      if (Math.round(funds.balance * 100) < input.amountCents)
        throw new PayableError('Saldo insuficiente na conta de pagamento');
      const now = new Date().toISOString();
      const transfer = this.db
        .prepare(
          'INSERT INTO transfers(user_id,source_account_id,destination_account_id,amount,date,name,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          userId,
          input.sourceAccountId,
          b.account_id,
          input.amountCents / 100,
          input.date,
          'Pagamento de fatura',
          now,
        );
      this.db
        .prepare(
          'INSERT INTO card_bill_payments(bill_id,transfer_id,amount_cents,payment_key,date) VALUES(?,?,?,?,?)',
        )
        .run(id, Number(transfer.lastInsertRowid), input.amountCents, input.key, input.date);
      return { transferId: Number(transfer.lastInsertRowid) };
    })();
  }
  refund(userId: number, purchaseId: number) {
    return this.db.transaction(() => {
      const p = this.db
        .prepare('SELECT * FROM card_purchases WHERE id=? AND user_id=?')
        .get(purchaseId, userId) as { account_id: number; name: string } | undefined;
      if (!p) throw new PayableError('Compra não encontrada', 404);
      const items = this.db
        .prepare(
          'SELECT i.*,b.due_date,b.closed,t.category_id FROM card_bill_items i JOIN card_bills b ON b.id=i.bill_id JOIN transactions t ON t.id=i.transaction_id WHERE i.purchase_id=?',
        )
        .all(purchaseId) as {
        bill_id: number;
        number: number;
        amount_cents: number;
        due_date: string;
        closed: number;
        category_id: number;
      }[];
      if (items.some((i) => i.amount_cents < 0)) return;
      for (const i of items) {
        if (
          i.closed ||
          this.db
            .prepare(
              'SELECT 1 FROM card_bill_movements WHERE (from_bill_id=? OR to_bill_id=?) AND voided=0',
            )
            .get(i.bill_id, i.bill_id) ||
          this.db.prepare('SELECT 1 FROM card_bill_payments WHERE bill_id=?').get(i.bill_id)
        )
          throw new PayableError(
            'Estorno de fatura fechada ou paga deve ser registrado na fatura de crédito correta',
            409,
          );
      }
      for (const i of items) {
        const now = new Date().toISOString();
        const tx = this.db
          .prepare(
            "INSERT INTO transactions(user_id,account_id,category_id,name,amount,type,subtype,date,created_at,updated_at) VALUES(?,?,?,?,?,'Ingreso','refund',?,?,?)",
          )
          .run(
            userId,
            p.account_id,
            i.category_id,
            p.name + ' — estorno',
            i.amount_cents / 100,
            i.due_date,
            now,
            now,
          );
        this.db
          .prepare(
            'INSERT INTO card_bill_items(bill_id,purchase_id,transaction_id,number,amount_cents) VALUES(?,?,?,?,?)',
          )
          .run(i.bill_id, purchaseId, Number(tx.lastInsertRowid), i.number, -i.amount_cents);
      }
    })();
  }
  private request<T>(
    userId: number,
    key: string | undefined,
    kind: string,
    input: object,
    run: () => T,
  ): T {
    return this.db.transaction(() => {
      const operationKey = key ?? randomUUID();
      const record = input as Record<string, unknown>;
      const payload = JSON.stringify(
        Object.fromEntries(
          Object.keys(record)
            .filter((k) => k !== 'key')
            .sort()
            .map((k) => [k, record[k]]),
        ),
      );
      const previous = this.db
        .prepare('SELECT * FROM card_requests WHERE operation_key=?')
        .get(operationKey) as
        { user_id: number; kind: string; payload: string; result: string } | undefined;
      if (previous) {
        if (previous.user_id !== userId || previous.kind !== kind || previous.payload !== payload)
          throw new PayableError('Identificador de operação já utilizado', 409);
        return JSON.parse(previous.result) as T;
      }
      const result = run();
      this.db
        .prepare(
          'INSERT INTO card_requests(user_id,operation_key,kind,payload,result) VALUES(?,?,?,?,?)',
        )
        .run(userId, operationKey, kind, payload, JSON.stringify(result ?? null));
      return result;
    })();
  }
  private targetBill(userId: number, accountId: number, dueDate: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO card_bills(user_id,account_id,due_date) VALUES(?,?,?)')
      .run(userId, accountId, dueDate);
    const b = this.db
      .prepare('SELECT id,closed FROM card_bills WHERE user_id=? AND account_id=? AND due_date=?')
      .get(userId, accountId, dueDate) as { id: number; closed: number };
    if (b.closed)
      throw new PayableError('A fatura de destino está fechada. Reabra ou selecione outra.', 409);
    return b;
  }
  reopen(userId: number, id: number) {
    this.bill(userId, id);
    this.db.prepare('UPDATE card_bills SET closed=0 WHERE id=?').run(id);
  }
  history(userId: number, id: number) {
    this.bill(userId, id);
    return {
      payments: this.db
        .prepare(
          'SELECT p.*,a.name source_account_name FROM card_bill_payments p JOIN transfers t ON t.id=p.transfer_id JOIN accounts a ON a.id=t.source_account_id WHERE p.bill_id=? ORDER BY p.id',
        )
        .all(id),
      movements: this.db
        .prepare(
          'SELECT m.*,s.due_date from_due,t.due_date to_due FROM card_bill_movements m JOIN card_bills s ON s.id=m.from_bill_id JOIN card_bills t ON t.id=m.to_bill_id WHERE m.from_bill_id=? OR m.to_bill_id=? ORDER BY m.id',
        )
        .all(id, id),
    };
  }
  undoPayment(userId: number, billId: number, paymentId: number, date: string) {
    return this.db.transaction(() => {
      const b = this.bill(userId, billId);
      const payment = this.db
        .prepare('SELECT * FROM card_bill_payments WHERE id=? AND bill_id=?')
        .get(paymentId, billId) as
        { transfer_id: number; reversal_transfer_id: number | null; date: string } | undefined;
      if (!payment) throw new PayableError('Pagamento não encontrado', 404);
      if (payment.reversal_transfer_id) return;
      if (date < payment.date)
        throw new PayableError('O desfazimento não pode ser anterior ao pagamento');
      const original = this.db
        .prepare('SELECT * FROM transfers WHERE id=?')
        .get(payment.transfer_id) as { source_account_id: number; amount: number };
      const reversal = this.db
        .prepare(
          'INSERT INTO transfers(user_id,source_account_id,destination_account_id,amount,date,name,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          userId,
          b.account_id,
          original.source_account_id,
          original.amount,
          date,
          'Pagamento de fatura desfeito',
          new Date().toISOString(),
        );
      this.db
        .prepare('UPDATE card_bill_payments SET reversal_transfer_id=? WHERE id=?')
        .run(Number(reversal.lastInsertRowid), paymentId);
    })();
  }
  refundToBill(
    userId: number,
    purchaseId: number,
    input: { amountCents: number; dueDate: string; key: string },
  ) {
    return this.request(userId, input.key, 'refund', { purchaseId, ...input }, () => {
      const p = this.db
        .prepare('SELECT * FROM card_purchases WHERE id=? AND user_id=?')
        .get(purchaseId, userId) as
        { account_id: number; name: string; purchase_date: string } | undefined;
      if (!p) throw new PayableError('Compra não encontrada', 404);
      if (input.dueDate < p.purchase_date)
        throw new PayableError('A fatura de estorno não pode ser anterior à compra');
      const refundable = this.db
        .prepare(
          'SELECT COALESCE(SUM(amount_cents),0) remaining FROM card_bill_items WHERE purchase_id=?',
        )
        .get(purchaseId) as { remaining: number };
      if (input.amountCents > refundable.remaining)
        throw new PayableError('Estorno maior que o valor ainda não estornado', 409);
      const source = this.db
        .prepare(
          'SELECT t.category_id FROM card_bill_items i JOIN transactions t ON t.id=i.transaction_id WHERE i.purchase_id=? AND i.amount_cents>0 ORDER BY i.id LIMIT 1',
        )
        .get(purchaseId) as { category_id: number } | undefined;
      if (!source) throw new PayableError('Compra sem parcelas');
      const bill = this.targetBill(userId, p.account_id, input.dueDate);
      const now = new Date().toISOString();
      const tx = this.db
        .prepare(
          "INSERT INTO transactions(user_id,account_id,category_id,name,amount,type,subtype,date,created_at,updated_at) VALUES(?,?,?,?,?,'Ingreso','refund',?,?,?)",
        )
        .run(
          userId,
          p.account_id,
          source.category_id,
          p.name + ' — estorno',
          input.amountCents / 100,
          input.dueDate,
          now,
          now,
        );
      this.db
        .prepare(
          'INSERT INTO card_bill_items(bill_id,purchase_id,transaction_id,number,amount_cents) VALUES(?,?,?,?,?)',
        )
        .run(bill.id, purchaseId, Number(tx.lastInsertRowid), 0, -input.amountCents);
      return { billId: bill.id };
    });
  }
  anticipate(
    userId: number,
    purchaseId: number,
    input: { fromNumber: number; dueDate: string; discountCents: number; key: string },
  ) {
    return this.request(userId, input.key, 'anticipate', { purchaseId, ...input }, () => {
      const p = this.db
        .prepare('SELECT * FROM card_purchases WHERE id=? AND user_id=?')
        .get(purchaseId, userId) as { account_id: number; purchase_date: string } | undefined;
      if (!p) throw new PayableError('Compra não encontrada', 404);
      if (input.dueDate < p.purchase_date)
        throw new PayableError('O vencimento não pode ser anterior à compra');
      const items = this.db
        .prepare(
          `SELECT i.*,b.due_date,b.closed FROM card_bill_items i JOIN card_bills b ON b.id=i.bill_id WHERE i.purchase_id=? AND i.number>=? AND i.amount_cents>0 AND b.due_date>?`,
        )
        .all(purchaseId, input.fromNumber, input.dueDate) as {
        id: number;
        bill_id: number;
        transaction_id: number;
        amount_cents: number;
        closed: number;
      }[];
      if (!items.length) throw new PayableError('Nenhuma parcela futura para antecipar');
      const total = items.reduce((sum, i) => sum + i.amount_cents, 0);
      if (input.discountCents > total)
        throw new PayableError('Desconto maior que as parcelas selecionadas');
      for (const i of items)
        if (
          i.closed ||
          this.db
            .prepare(
              'SELECT 1 FROM card_bill_payments WHERE bill_id=? AND reversal_transfer_id IS NULL',
            )
            .get(i.bill_id) ||
          this.db
            .prepare(
              'SELECT 1 FROM card_bill_movements WHERE (from_bill_id=? OR to_bill_id=?) AND voided=0',
            )
            .get(i.bill_id, i.bill_id)
        )
          throw new PayableError(
            'Reabra e confira as faturas: parcelas pagas ou com saldo transferido não podem ser antecipadas',
            409,
          );
      const target = this.targetBill(userId, p.account_id, input.dueDate);
      for (const i of items) {
        this.db.prepare('UPDATE card_bill_items SET bill_id=? WHERE id=?').run(target.id, i.id);
        this.db
          .prepare('UPDATE transactions SET date=?,updated_at=? WHERE id=?')
          .run(input.dueDate, new Date().toISOString(), i.transaction_id);
      }
      if (input.discountCents)
        this.refundToBill(userId, purchaseId, {
          amountCents: input.discountCents,
          dueDate: input.dueDate,
          key: randomUUID(),
        });
      return { billId: target.id, amountCents: total - input.discountCents, count: items.length };
    });
  }
  carry(userId: number, id: number, input: { dueDate: string; key: string }) {
    return this.request(userId, input.key, 'carry', { id, ...input }, () => {
      const b = this.bill(userId, id);
      const row = this.db
        .prepare(`SELECT due_date,${totalSql}-${paidSql} remaining FROM card_bills b WHERE b.id=?`)
        .get(id) as { due_date: string; remaining: number };
      if (input.dueDate <= row.due_date) throw new PayableError('Escolha uma fatura posterior');
      if (!row.remaining) throw new PayableError('A fatura não possui saldo para transferir');
      const target = this.targetBill(userId, b.account_id, input.dueDate);
      const movement = this.db
        .prepare(
          'INSERT INTO card_bill_movements(from_bill_id,to_bill_id,amount_cents,created_at) VALUES(?,?,?,?)',
        )
        .run(id, target.id, row.remaining, new Date().toISOString());
      this.close(userId, id);
      return { movementId: Number(movement.lastInsertRowid), billId: target.id };
    });
  }
  undoCarry(userId: number, id: number, movementId: number) {
    return this.db.transaction(() => {
      this.bill(userId, id);
      const m = this.db
        .prepare('SELECT * FROM card_bill_movements WHERE id=? AND from_bill_id=?')
        .get(movementId, id) as { to_bill_id: number; voided: number } | undefined;
      if (!m) throw new PayableError('Transferência de saldo não encontrada', 404);
      if (m.voided) return;
      const target = this.bill(userId, m.to_bill_id);
      if (
        target.closed ||
        this.db
          .prepare(
            'SELECT 1 FROM card_bill_payments WHERE bill_id=? AND reversal_transfer_id IS NULL',
          )
          .get(target.id) ||
        this.db
          .prepare('SELECT 1 FROM card_bill_movements WHERE from_bill_id=? AND voided=0')
          .get(target.id)
      )
        throw new PayableError(
          'Reabra a fatura de destino e desfaça seus pagamentos/transferências antes de devolver o saldo',
          409,
        );
      this.db.prepare('UPDATE card_bill_movements SET voided=1 WHERE id=?').run(movementId);
    })();
  }
  unassigned(userId: number, accountId: number) {
    return this.db
      .prepare(
        "SELECT t.id,t.name,t.amount,t.type,t.date FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.user_id=? AND a.id=? AND a.type='Crédito' AND NOT EXISTS(SELECT 1 FROM card_bill_items i WHERE i.transaction_id=t.id) ORDER BY t.date,t.id",
      )
      .all(userId, accountId);
  }
  assign(userId: number, transactionId: number, input: { dueDate: string; key: string }) {
    return this.request(userId, input.key, 'assign', { transactionId, ...input }, () => {
      const t = this.db
        .prepare(
          "SELECT t.* FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.id=? AND t.user_id=? AND a.type='Crédito'",
        )
        .get(transactionId, userId) as
        | { account_id: number; name: string; amount: number; type: string; date: string }
        | undefined;
      if (!t) throw new PayableError('Lançamento do cartão não encontrado', 404);
      if (
        this.db.prepare('SELECT 1 FROM card_bill_items WHERE transaction_id=?').get(transactionId)
      )
        throw new PayableError('Lançamento já vinculado a uma fatura', 409);
      const originalDate = t.date.slice(0, 10);
      if (input.dueDate < originalDate)
        throw new PayableError('O vencimento não pode ser anterior ao lançamento');
      const amount = Math.round(t.amount * 100);
      const b = this.targetBill(userId, t.account_id, input.dueDate);
      const p = this.db
        .prepare(
          'INSERT INTO card_purchases(user_id,account_id,name,total_cents,installments,purchase_date) VALUES(?,?,?,?,1,?)',
        )
        .run(userId, t.account_id, t.name, amount, originalDate);
      this.db
        .prepare(
          'INSERT INTO card_bill_items(bill_id,purchase_id,transaction_id,number,amount_cents) VALUES(?,?,?,?,?)',
        )
        .run(
          b.id,
          Number(p.lastInsertRowid),
          transactionId,
          1,
          t.type === 'Gasto' ? amount : -amount,
        );
      this.db
        .prepare('UPDATE transactions SET date=?,updated_at=? WHERE id=?')
        .run(input.dueDate, new Date().toISOString(), transactionId);
      return { billId: b.id };
    });
  }
}
