import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import CardBillTools from './CardBillTools.svelte';
import { preferences } from '$lib/stores/preferences';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('$lib/api/client', () => ({ apiGet: get, apiPost: post }));
const bill = {
  id: 1,
  account_id: 2,
  due_date: '2026-01-10',
  total_cents: 10000,
  paid_cents: 10000,
  closed: 1,
};
beforeEach(() => {
  preferences.set({ locale: 'pt-BR', currency: 'BRL' });
  post.mockReset();
  post.mockResolvedValue({});
  get.mockReset();
  get.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/items')
        ? [
            {
              id: 1,
              purchase_id: 4,
              name: 'Sofá',
              number: 1,
              installments: 4,
              amount_cents: 10000,
              refundable_cents: 40000,
              purchase_date: '2026-01-01',
            },
          ]
        : url.endsWith('/history')
          ? {
              payments: [
                {
                  id: 9,
                  amount_cents: 10000,
                  date: '2026-01-10',
                  source_account_name: 'Banco',
                  reversal_transfer_id: null,
                },
              ],
              movements: [],
            }
          : [{ id: 2, currency: 'BRL' }],
    ),
  );
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
describe('card statement controls', () => {
  it('records a partial refund on a later statement even when original is closed and paid', async () => {
    render(CardBillTools, { bill, refreshed: vi.fn().mockResolvedValue(undefined) });
    await fireEvent.click(screen.getByRole('button', { name: 'Compras e histórico' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Estornar compra' }));
    await fireEvent.input(screen.getByLabelText('Valor a estornar'), {
      target: { value: '50.01' },
    });
    await fireEvent.input(screen.getByLabelText('Vencimento da fatura que receberá o crédito'), {
      target: { value: '2026-02-10' },
    });
    await fireEvent.submit(screen.getByRole('form', { name: 'Estornar compra' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/payables/purchases/4/refund', {
        amountCents: 5001,
        dueDate: '2026-02-10',
        key: expect.any(String),
      }),
    );
  });
  it('exposes payment reversal with confirmation', async () => {
    render(CardBillTools, { bill, refreshed: vi.fn().mockResolvedValue(undefined) });
    await fireEvent.click(screen.getByRole('button', { name: 'Compras e histórico' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Desfazer pagamento' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/payables/bills/1/payments/9/undo', {
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    );
    expect(window.confirm).toHaveBeenCalled();
  });
  it('sends installment anticipation with a bank-provided discount', async () => {
    render(CardBillTools, { bill, refreshed: vi.fn().mockResolvedValue(undefined) });
    await fireEvent.click(screen.getByRole('button', { name: 'Compras e histórico' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Antecipar parcelas' }));
    await fireEvent.input(screen.getByLabelText('Antecipar a partir da parcela'), {
      target: { value: '2' },
    });
    await fireEvent.input(screen.getByLabelText('Desconto concedido pelo banco'), {
      target: { value: '20' },
    });
    await fireEvent.input(screen.getByLabelText('Vencimento da fatura de antecipação'), {
      target: { value: '2026-01-10' },
    });
    await fireEvent.submit(screen.getByRole('form', { name: 'Antecipar parcelas' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables/purchases/4/anticipate',
        expect.objectContaining({ fromNumber: 2, discountCents: 2000, dueDate: '2026-01-10' }),
      ),
    );
  });
  it('carries a credit with an explicit future due date', async () => {
    render(CardBillTools, {
      bill: { ...bill, total_cents: -5000, paid_cents: 0 },
      refreshed: vi.fn().mockResolvedValue(undefined),
    });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Transferir saldo para outra fatura' }),
    );
    await fireEvent.input(screen.getByLabelText('Vencimento da fatura de destino'), {
      target: { value: '2026-02-10' },
    });
    await fireEvent.submit(
      screen.getByRole('form', { name: 'Transferir saldo para outra fatura' }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables/bills/1/carry',
        expect.objectContaining({ dueDate: '2026-02-10' }),
      ),
    );
  });
});
