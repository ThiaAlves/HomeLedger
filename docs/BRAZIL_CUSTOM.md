# HomeLedger — versão custom brasileira

Branch custom: `custom/br-finances`, destinada ao fork `ThiaAlves/HomeLedger` (remote `fork`). O fork é público; esta branch não é enviada ao projeto original. Esta customização inclui a tradução pt-BR da branch de origem. Não requer serviço externo, credenciais bancárias nem novas variáveis de ambiente.

## Começar

1. Configure idioma Português (Brasil) e moeda BRL em Configurações.
2. Cadastre suas contas bancárias e cartões em Contas. No cartão, informe limite, fechamento e vencimento.
3. Abra **Contas e receitas**, disponível nos dois temas.
4. Em **Adicionar gasto**, escolha o tipo, conta, categoria e próximo vencimento.

| Tipo | Valor informado | Funcionamento |
| --- | --- | --- |
| À vista / boleto avulso | Valor do pagamento | Um vencimento; registre o pagamento quando realizado. |
| Conta recorrente | Valor estimado ou fixo por mês | Previsão contínua; ajuste a conta de luz antes de pagar, por exemplo. |
| Compra parcelada no boleto | Total original da compra | Distribui centavos entre as parcelas. |
| Consórcio | Prestação atual | Prazo definido e histórico de eventos do contrato. |
| Financiamento / Minha Casa Minha Vida | Prestação atual | Prazo definido, histórico e saldo devedor informado no extrato. |
| Compra no cartão | Total original da compra | Distribui parcelas por fatura e compromete o limite pelo saldo das parcelas cadastradas. |

Para contratos e compras já em andamento, informe a quantidade **total original**, o número da primeira parcela ainda a acompanhar e seu vencimento. Por exemplo: 80 parcelas, começar na 18, vencimento de dezembro. As 17 anteriores não criam transações.

## Receitas recorrentes e salário

Em **Contas e receitas → Nova receita**, informe descrição (por exemplo, Salário), valor previsto, primeiro recebimento, conta de destino e uma categoria de receita. A opção mensal gera previsões contínuas. Também é possível cadastrar um recebimento único.

O cadastro não aumenta o saldo bancário. Na aba **Receitas**, use **Registrar recebimento** quando o dinheiro entrar, ajustando data e valor se necessário. O sistema cria uma receita na conta selecionada, permite recebimentos parciais e evita duplicação ao repetir a mesma requisição. Reajustes nas previsões futuras preservam os recebimentos anteriores.

A tela separa **Despesas**, **Receitas** e **Faturas** em abas reais. A lista compacta mostra descrição, categoria, vencimento, conta e valor. Os atrasados aparecem primeiro; a busca, os filtros de conta/situação e a ordenação ajudam a localizar itens. Ações de editar, cancelar e encerrar ficam em **Mais opções**. Os totais separam receitas previstas, recebidas e despesas, sem tratar salário futuro como dinheiro já disponível.

O painel e o calendário identificam receitas sem somá-las às despesas previstas. A migração aditiva `0020_recurring_income` mantém os compromissos existentes como despesas. Backups anteriores à receita recorrente continuam aceitos.

## Pagamentos e ajustes

Um vencimento em aberto não afeta o saldo bancário. **Registrar pagamento** cria uma despesa na conta vinculada, com data e valor efetivamente pagos. São permitidos pagamentos parciais até o saldo restante. Repetir a mesma requisição de pagamento não duplica a movimentação.

**Ajustar valor** altera uma parcela sem pagamento ou também as futuras sem pagamento. Valores já pagos permanecem preservados. **Cancelar parcela** cancela somente uma parcela sem pagamentos. **Encerrar** cancela todas as parcelas sem pagamentos e interrompe a geração de novos vencimentos da recorrência. Parcelas parcialmente pagas continuam abertas pelo valor restante.

As recorrências mantêm uma previsão de 24 meses a partir do mês atual, ampliada ao consultar contas a pagar, calendário ou resumo do painel. Não há débito automático no novo módulo.

Na conversão opcional de uma assinatura mensal existente, o cadastro antigo fica inativo e seu lançamento automático é desabilitado na mesma transação que cria a recorrência. O histórico existente é mantido. Assinaturas semanais continuam no módulo original. Confira o próximo vencimento antes da conversão.

## Cartão

Cada parcela pertence a uma fatura identificada pelo cartão e vencimento. O dia configurado no cartão é preservado depois de meses curtos (por exemplo: 28/02, 31/03, 30/04). A primeira fatura é sugerida usando fechamento e vencimento do cartão; a seleção é editável para conferir com o banco. Compras na data de fechamento são sugeridas para o próximo ciclo.

As despesas do cartão são datadas pelo vencimento da parcela para os relatórios mensais. A data original da compra fica no cadastro da compra. Todas as parcelas cadastradas comprometem imediatamente o saldo/limite do cartão, aproveitando a regra existente de saldo do projeto, que inclui transações futuras.

Pagar a fatura cria **uma transferência** da conta bancária para o cartão, sem repetir as despesas. A conta de origem precisa estar ativa, ter saldo suficiente e usar a mesma moeda do cartão. É possível pagar parcialmente e consultar o saldo restante. **Fechar fatura** bloqueia novas compras naquele ciclo.

**Compras e histórico** mostra os itens, pagamentos e saldos transferidos. As operações disponíveis são:

- **Estornar compra**: informe o valor parcial ou total e o vencimento da fatura aberta em que o banco concedeu o crédito. Compras em faturas já fechadas ou pagas também podem receber estorno em outra fatura, preservando compras e pagamentos anteriores. O sistema impede estorno acima do total ainda não estornado.
- **Antecipar parcelas**: escolha a partir de qual parcela, o vencimento de destino e o desconto informado pelo banco. Move somente parcelas posteriores ao destino, de faturas abertas, sem pagamentos ativos nem saldo transferido. Não cria nova despesa para as parcelas movidas; desconto é registrado como crédito. O valor antecipado ainda precisa ser pago na fatura de destino.
- **Reabrir fatura**: permite corrigir um ciclo fechado. Não desfaz pagamentos.
- **Desfazer pagamento**: preserva a transferência original e cria uma transferência inversa na data atual, devolvendo o valor à conta de origem e reabrindo o saldo da fatura. O histórico identifica o pagamento desfeito. Repetir a operação não duplica a devolução.
- **Transferir saldo para outra fatura**: leva o saldo devedor restante ou crédito a uma fatura posterior, sem gerar outra despesa ou transferência bancária. O ciclo de origem fica fechado e o saldo passa a ser acompanhado no destino.
- **Devolver saldo à fatura de origem**: desfaz uma transferência de saldo, desde que o destino esteja aberto, sem pagamentos ativos e sem ter transferido esse saldo adiante. Se necessário, desfaça os eventos mais recentes primeiro.

Juros, multa, IOF e tarifas são informados conforme o extrato: cadastre como compra de uma parcela, com categoria e descrição correspondentes. O sistema acompanha o saldo transferido; não estima automaticamente os encargos do rotativo nem substitui os cálculos do banco.

**Vincular lançamento existente a uma fatura** atende compras ou créditos já registrados em Transações, importações ou assinaturas. O vínculo reaproveita a transação, preserva a data original no cadastro da compra e usa o vencimento no relatório mensal. Não lance novamente a mesma compra pelo formulário de parcelamento. Transações já vinculadas não aparecem novamente na lista.

Ao começar com um cartão existente, o saldo inicial deve representar somente valores que não serão cadastrados ou importados em transações, para não contar a mesma dívida duas vezes.

Transações e transferências vinculadas (inclusive as inversas) ficam protegidas contra edição/exclusão pelos formulários genéricos. Utilize os controles de fatura para manter os vínculos consistentes. As operações de compra, estorno, antecipação e transferência de saldo usam identificadores de requisição para evitar duplicações em novas tentativas de rede.


## Consórcio e financiamento

Os cadastros permitem registrar banco/administradora, contrato e observações (inclusive grupo e cota). **Contrato e histórico** registra atualização de saldo, amortização extraordinária/FGTS, lance, contemplação e reajuste.

O saldo devedor é sempre informado pelo usuário a partir de contrato ou extrato, com sua data de referência. A prestação inteira não é automaticamente tratada como amortização. Para recursos próprios, marque a opção de registrar a saída da conta; para FGTS ou um valor já lançado, deixe-a desmarcada.

Os eventos de reajuste/lance documentam o ocorrido. Ajuste as parcelas futuras pela ação de valor; o sistema não calcula automaticamente o efeito de um lance no prazo. Não há simulador SAC/Price, cálculo bancário do Minha Casa Minha Vida nem indexação automática de consórcio nesta versão.

## Integração e manutenção

- O painel resume o saldo a pagar do mês por moeda, sem somar moedas diferentes.
- O calendário reúne assinaturas ativas, vencimentos abertos e faturas com saldo. O novo módulo tem filtro mensal e totais previstos, pagos e restantes.
- Os relatórios existentes recebem as despesas e transferências correspondentes. No cartão, o mês de referência é o vencimento da parcela.
- A migração aditiva `0018_brazilian_payables` cria tabelas próprias; `0019_card_workflow` amplia o fluxo de cartão. Nenhuma delas converte cadastros existentes automaticamente. A inicialização normal do backend aplica a migração.
- As tabelas usam SQL direto, como outros módulos existentes. Estão incluídas no backup JSON e na restauração, com remapeamento de contas, categorias, transações e transferências e substituição atômica. Backups antigos continuam aceitos.
- O destino de uma restauração deve executar esta versão custom. A versão original do projeto não conhece os campos brasileiros.
- Não substitua um banco atualizado por uma versão antiga esperando que ela gerencie estes novos vínculos.

## Desenvolvimento local

Use Node 24 (o projeto exige no mínimo Node 22.13). Na raiz do repositório:

```sh
npm run dev:backend
npm run dev:frontend
```

Validação: typecheck backend/frontend, suíte Vitest backend/frontend, build e lint. O teste de limite de segurança desktop abre um socket loopback e exige permissão no ambiente de execução.

## Validação desta implementação

Use Node 24.16.0. A validação inclui typecheck backend/frontend, testes backend/shared e frontend, build e lint. Os testes cobrem migrações reais em SQLite, centavos, datas, contratos em andamento, pagamentos parciais, repetição de requisições, isolamento por usuário, faturas, estornos parciais após pagamento, reversão de pagamento, antecipação com desconto, saldos transferidos, conversão de assinaturas, backup e os formulários principais.

Resultado final com Node 24.16.0: **784 testes backend/shared e 159 testes frontend aprovados**, typecheck backend/frontend e build aprovados, lint sem erros e com os 80 avisos preexistentes.

Também foi executado o Chrome headless com servidor e banco temporários: estorno parcial, pagamento, desfazer pagamento e atualização do histórico pela interface; tema Normal e Cyberpunk; tela móvel de 390 px sem rolagem horizontal. O roteiro reproduzível está em `scripts/qa-br-card.mjs` e pode ser executado após `npm run build`:

```sh
node scripts/qa-br-card.mjs
```

O roteiro usa o Chrome instalado no macOS por padrão. Em outro ambiente, defina `CHROME_BIN` com o caminho do executável. Os dados e capturas são temporários, sem usar o banco real nem publicar conteúdo.

A revisão de receitas recorrentes também foi conferida no Chrome: cadastro de salário mensal e confirmação do recebimento pela interface, com aumento correto do saldo bancário. A lista compacta e as abas foram revisadas nos dois temas e em tela móvel, preservando os ajustes visuais existentes.
