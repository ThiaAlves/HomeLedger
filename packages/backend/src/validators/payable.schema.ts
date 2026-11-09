import { z } from 'zod';
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    'Data inválida',
  );
export const commitmentSchema = z
  .object({
    direction: z.enum(['expense', 'income']).default('expense'),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['once', 'recurring', 'installment', 'consortium', 'housing']),
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive(),
    amountCents: z.number().int().positive().max(99999999999),
    installments: z.number().int().min(1).max(600).default(1),
    firstNumber: z.number().int().min(1).max(600).default(1),
    firstDue: calendarDate,
    details: z
      .object({
        institution: z.string().max(100).optional(),
        contract: z.string().max(100).optional(),
        group: z.string().max(50).optional(),
        quota: z.string().max(50).optional(),
        outstandingCents: z.number().int().nonnegative().optional(),
        referenceDate: calendarDate.optional(),
        notes: z.string().max(2000).optional(),
      })
      .default({}),
  })
  .superRefine((v, c) => {
    if (v.direction === 'income' && !['once', 'recurring'].includes(v.kind))
      c.addIssue({
        code: 'custom',
        message: 'Receitas permitem recebimento único ou recorrência mensal',
        path: ['kind'],
      });
    if (v.firstNumber > v.installments)
      c.addIssue({
        code: 'custom',
        message: 'Parcela inicial maior que o prazo',
        path: ['firstNumber'],
      });
    if (v.kind === 'once' && v.installments !== 1)
      c.addIssue({
        code: 'custom',
        message: 'Pagamento único deve ter uma parcela',
        path: ['installments'],
      });
    if (v.kind === 'installment' && v.amountCents < v.installments)
      c.addIssue({
        code: 'custom',
        message: 'Total insuficiente para distribuir as parcelas',
        path: ['amountCents'],
      });
  });
export const payablePaymentSchema = z.object({
  amountCents: z.number().int().positive().max(99999999999),
  date: calendarDate,
  key: z.string().uuid(),
});
export const payableUpdateSchema = z.object({
  amountCents: z.number().int().positive().max(99999999999),
  scope: z.enum(['one', 'future']).default('one'),
});
export type CommitmentInput = z.infer<typeof commitmentSchema>;
