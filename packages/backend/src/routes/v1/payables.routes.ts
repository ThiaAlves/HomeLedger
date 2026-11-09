import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PayableService } from '../../services/payable.service.js';
import {
  commitmentSchema,
  payablePaymentSchema,
  payableUpdateSchema,
} from '../../validators/payable.schema.js';
import { CardBillService } from '../../services/card-bill.service.js';
import { calendarDate } from '../../validators/payable.schema.js';
const purchaseSchema = z
  .object({
    key: z.string().uuid().optional(),
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    amountCents: z.number().int().positive().max(99999999999),
    installments: z.number().int().min(1).max(600),
    firstNumber: z.number().int().min(1).max(600).default(1),
    date: calendarDate,
    firstDue: calendarDate,
  })
  .refine(
    (v) =>
      v.firstNumber <= v.installments && v.amountCents >= v.installments && v.firstDue >= v.date,
    'Valores ou datas inválidos',
  );
const params = z.object({ id: z.coerce.number().int().positive() });
export async function payableRoutes(app: FastifyInstance) {
  const service = new PayableService();
  const cards = new CardBillService();
  app.get('/cards/:id/unassigned', async (request) => ({
    success: true,
    data: cards.unassigned(request.user!.userId, params.parse(request.params).id),
  }));
  app.post('/transactions/:id/assign', async (request) => ({
    success: true,
    data: cards.assign(
      request.user!.userId,
      params.parse(request.params).id,
      z.object({ dueDate: calendarDate, key: z.string().uuid() }).parse(request.body),
    ),
  }));
  app.post('/subscriptions/:id/convert', async (request) => ({
    success: true,
    data: service.migrateSubscription(request.user!.userId, params.parse(request.params).id),
  }));
  app.get('/commitments/:id', async (request) => ({
    success: true,
    data: service.contract(request.user!.userId, params.parse(request.params).id),
  }));
  app.post('/commitments/:id/events', async (request) => {
    const body = z
      .object({
        key: z.string().uuid().optional(),
        kind: z.enum(['balance', 'amortization', 'bid', 'contemplation', 'adjustment']),
        date: calendarDate,
        amountCents: z.number().int().nonnegative().max(99999999999),
        outstandingCents: z.number().int().nonnegative().max(99999999999).optional(),
        notes: z.string().max(2000).default(''),
        recordExpense: z.boolean().default(false),
      })
      .parse(request.body);
    service.event(request.user!.userId, params.parse(request.params).id, body);
    return { success: true, data: null };
  });
  app.post('/purchases/:id/refund', async (request) => ({
    success: true,
    data: cards.refundToBill(
      request.user!.userId,
      params.parse(request.params).id,
      z
        .object({
          amountCents: z.number().int().positive().max(99999999999),
          dueDate: calendarDate,
          key: z.string().uuid(),
        })
        .parse(request.body),
    ),
  }));
  app.post('/purchases/:id/anticipate', async (request) => ({
    success: true,
    data: cards.anticipate(
      request.user!.userId,
      params.parse(request.params).id,
      z
        .object({
          fromNumber: z.number().int().min(1).max(600),
          dueDate: calendarDate,
          discountCents: z.number().int().nonnegative().max(99999999999).default(0),
          key: z.string().uuid(),
        })
        .parse(request.body),
    ),
  }));
  app.get('/bills/:id/history', async (request) => ({
    success: true,
    data: cards.history(request.user!.userId, params.parse(request.params).id),
  }));
  app.post('/bills/:id/reopen', async (request) => {
    cards.reopen(request.user!.userId, params.parse(request.params).id);
    return { success: true, data: null };
  });
  app.post('/bills/:id/carry', async (request) => ({
    success: true,
    data: cards.carry(
      request.user!.userId,
      params.parse(request.params).id,
      z.object({ dueDate: calendarDate, key: z.string().uuid() }).parse(request.body),
    ),
  }));
  app.post('/bills/:id/movements/:movementId/undo', async (request) => {
    const p = z
      .object({
        id: z.coerce.number().int().positive(),
        movementId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    cards.undoCarry(request.user!.userId, p.id, p.movementId);
    return { success: true, data: null };
  });
  app.post('/bills/:id/payments/:paymentId/undo', async (request) => {
    const p = z
      .object({
        id: z.coerce.number().int().positive(),
        paymentId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    cards.undoPayment(
      request.user!.userId,
      p.id,
      p.paymentId,
      z.object({ date: calendarDate }).parse(request.body).date,
    );
    return { success: true, data: null };
  });
  app.get('/bills', async (request) => ({ success: true, data: cards.list(request.user!.userId) }));
  app.get('/bills/:id/items', async (request) => ({
    success: true,
    data: cards.items(request.user!.userId, params.parse(request.params).id),
  }));
  app.post('/purchases', async (request) => ({
    success: true,
    data: cards.purchase(request.user!.userId, purchaseSchema.parse(request.body)),
  }));
  app.post('/bills/:id/close', async (request) => {
    cards.close(request.user!.userId, params.parse(request.params).id);
    return { success: true, data: null };
  });
  app.post('/bills/:id/pay', async (request) => ({
    success: true,
    data: cards.pay(
      request.user!.userId,
      params.parse(request.params).id,
      payablePaymentSchema
        .extend({ sourceAccountId: z.number().int().positive() })
        .parse(request.body),
    ),
  }));
  app.get('/', async (request) => ({ success: true, data: service.list(request.user!.userId) }));
  app.post('/', async (request, reply) =>
    reply.code(201).send({
      success: true,
      data: service.create(request.user!.userId, commitmentSchema.parse(request.body)),
    }),
  );
  app.post('/:id/pay', async (request) => ({
    success: true,
    data: service.pay(
      request.user!.userId,
      params.parse(request.params).id,
      payablePaymentSchema.parse(request.body),
    ),
  }));
  app.patch('/:id', async (request) => {
    const body = payableUpdateSchema.parse(request.body);
    service.update(
      request.user!.userId,
      params.parse(request.params).id,
      body.amountCents,
      body.scope === 'future',
    );
    return { success: true, data: null };
  });
  app.post('/:id/cancel', async (request) => {
    service.cancel(request.user!.userId, params.parse(request.params).id);
    return { success: true, data: null };
  });
  app.post('/commitments/:id/stop', async (request) => {
    service.stop(request.user!.userId, params.parse(request.params).id);
    return { success: true, data: null };
  });
}
