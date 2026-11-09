import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte';
import Page from './+page.svelte';
import { preferences } from '$lib/stores/preferences';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('$lib/api/client', () => ({ apiGet: get, apiPost: post, apiPatch: vi.fn() }));
beforeEach(() => {
  preferences.set({ locale: 'pt-BR', currency: 'BRL' });
  post.mockReset();
  post.mockResolvedValue({});
  get.mockReset();
  get.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/accounts'
        ? [
            { id: 1, name: 'Banco', type: 'Débito', currency: 'BRL' },
            {
              id: 2,
              name: 'Cartão',
              type: 'Crédito',
              currency: 'BRL',
              statementDay: 5,
              paymentDueDay: 15,
            },
          ]
        : path === '/categories'
          ? [{ id: 1, name: 'Casa', type: 'Gasto' }]
          : [],
    ),
  );
});
describe('Brazilian expense registration', () => {
  it('saves a finite installment series in cents with no payment request', async () => {
    const { container } = render(Page);
    await fireEvent.click(screen.getByRole('button',{name:/Adicionar gasto/}));
    await screen.findByRole('option', { name: 'Banco (BRL)' });
    await fireEvent.change(screen.getByLabelText('Tipo de gasto'), {
      target: { value: 'installment' },
    });
    await fireEvent.input(screen.getByLabelText('Descrição'), { target: { value: 'Sofá' } });
    await fireEvent.input(screen.getByLabelText('Valor total da compra'), {
      target: { value: '100.01' },
    });
    await fireEvent.input(screen.getByLabelText('Quantidade total de parcelas'), {
      target: { value: '3' },
    });
    await fireEvent.change(screen.getByLabelText('Conta de pagamento / cartão'), {
      target: { value: '1' },
    });
    await fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: '1' } });
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables',
        expect.objectContaining({
          name: 'Sofá',
          amountCents: 10001,
          installments: 3,
          firstNumber: 1,
          accountId: 1,
        }),
      ),
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('suggests a first card statement and supports an ongoing purchase', async () => {
    const { container } = render(Page);
    await fireEvent.click(screen.getByRole('button',{name:/Adicionar gasto/}));
    await screen.findByRole('option', { name: 'Banco (BRL)' });
    await fireEvent.change(screen.getByLabelText('Tipo de gasto'), { target: { value: 'card' } });
    await fireEvent.input(screen.getByLabelText('Descrição'), {
      target: { value: 'Compra antiga' },
    });
    await fireEvent.input(screen.getByLabelText('Valor total da compra'), {
      target: { value: '1000' },
    });
    await fireEvent.input(screen.getByLabelText('Quantidade total de parcelas'), {
      target: { value: '10' },
    });
    await fireEvent.input(screen.getByLabelText('Começar na parcela'), { target: { value: '8' } });
    await fireEvent.input(screen.getByLabelText('Data da compra'), {
      target: { value: '2026-11-06' },
    });
    await fireEvent.change(screen.getByLabelText('Conta de pagamento / cartão'), {
      target: { value: '2' },
    });
    expect(screen.getByLabelText('Vencimento da primeira fatura')).toHaveValue('2026-12-15');
    await fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: '1' } });
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables/purchases',
        expect.objectContaining({
          installments: 10,
          firstNumber: 8,
          amountCents: 100000,
          firstDue: '2026-12-15',
        }),
      ),
    );
  });
  it('pays a card statement through the bill endpoint without creating an expense', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/payables/bills'
          ? [
              {
                id: 9,
                account_id: 2,
                account_name: 'Cartão',
                due_date: new Date().toISOString().slice(0, 7) + '-15',
                total_cents: 12345,
                paid_cents: 0,
                closed: 1,
              },
            ]
          : path === '/accounts'
            ? [
                { id: 1, name: 'Banco', type: 'Débito', currency: 'BRL' },
                { id: 2, name: 'Cartão', type: 'Crédito', currency: 'BRL' },
              ]
            : [],
      ),
    );
    render(Page);
    await fireEvent.click(await screen.findByRole('tab', { name: /Faturas|Cartões/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Registrar pagamento' }));
    const section = screen.getByRole('region', { name: 'Registrar pagamento' });
    await fireEvent.change(within(section).getByLabelText('Conta de pagamento / cartão'), {
      target: { value: '1' },
    });
    await fireEvent.submit(section.querySelector('form')!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables/bills/9/pay',
        expect.objectContaining({
          sourceAccountId: 1,
          amountCents: 12345,
          key: expect.any(String),
        }),
      ),
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('income and organized expense list', () => {
  it('creates a monthly salary with an income category and receiving account', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/accounts'
          ? [{ id: 1, name: 'Banco', type: 'Débito', currency: 'BRL' }]
          : path === '/categories'
            ? [
                { id: 1, name: 'Casa', type: 'Gasto' },
                { id: 3, name: 'Salário', type: 'Ingreso' },
              ]
            : [],
      ),
    );
    const { container } = render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Nova receita' }));
    await screen.findByRole('option', { name: 'Banco (BRL)' });
    await fireEvent.input(screen.getByLabelText('Descrição'), { target: { value: 'Meu salário' } });
    await fireEvent.input(screen.getByLabelText('Valor previsto'), { target: { value: '5000' } });
    await fireEvent.change(screen.getByLabelText('Conta de recebimento'), {
      target: { value: '1' },
    });
    await fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: '3' } });
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables',
        expect.objectContaining({
          direction: 'income',
          kind: 'recurring',
          amountCents: 500000,
          categoryId: 3,
        }),
      ),
    );
  });
  it('separates salary from expenses and confirms receipt through its own endpoint', async () => {
    const month = new Date().toISOString().slice(0, 7);
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/payables'
          ? [
              {
                id: 51,
                commitment_id: 1,
                name: 'Salário do mês',
                direction: 'income',
                kind: 'recurring',
                number: 1,
                total_installments: 1,
                due_date: month + '-05',
                amount_cents: 500000,
                paid_cents: 0,
                cancelled: 0,
                account_id: 1,
                category_id: 3,
              },
              {
                id: 52,
                commitment_id: 2,
                name: 'Conta de luz',
                direction: 'expense',
                kind: 'recurring',
                number: 1,
                total_installments: 1,
                due_date: month + '-10',
                amount_cents: 10000,
                paid_cents: 0,
                cancelled: 0,
                account_id: 1,
                category_id: 1,
              },
            ]
          : path === '/accounts'
            ? [{ id: 1, name: 'Banco', type: 'Débito', currency: 'BRL' }]
            : [],
      ),
    );
    render(Page);
    await screen.findByRole('heading', { name: 'Conta de luz' });
    expect(screen.queryByRole('heading', { name: 'Salário do mês' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('tab', { name: /^Receitas/ }));
    await screen.findByRole('heading', { name: 'Salário do mês' });
    expect(screen.queryByRole('heading', { name: 'Conta de luz' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    const region = screen.getByRole('region', { name: 'Registrar recebimento' });
    await fireEvent.submit(region.querySelector('form')!);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/payables/51/receive',
        expect.objectContaining({ amountCents: 500000, key: expect.any(String) }),
      ),
    );
  });
  it('searches expenses and keeps secondary actions collapsed', async () => {
    const month = new Date().toISOString().slice(0, 7);
    get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/payables'
          ? ['Aluguel', 'Internet'].map((name, i) => ({
              id: i + 1,
              commitment_id: i + 1,
              name,
              direction: 'expense',
              kind: 'recurring',
              number: 1,
              total_installments: 1,
              due_date: month + '-10',
              amount_cents: 10000,
              paid_cents: 0,
              cancelled: 0,
              account_id: 1,
              category_id: 1,
            }))
          : [],
      ),
    );
    render(Page);
    await screen.findByRole('heading', { name: 'Aluguel' });
    expect(
      [...document.querySelectorAll<HTMLDetailsElement>('details.row-more')].every((d) => !d.open),
    ).toBe(true);
    await fireEvent.input(screen.getByLabelText('Buscar por descrição ou categoria'), {
      target: { value: 'Internet' },
    });
    expect(screen.queryByRole('heading', { name: 'Aluguel' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Internet' })).toBeInTheDocument();
  });
});
