# Sistema de Vendas — Loja de Material de Construção

Sistema web de frente de caixa (PDV), estoque, clientes, crediário e emissão de
**cupom de venda interno**, feito em Node.js + Express + sql.js, com frontend em
HTML/CSS/JS puro — o mesmo padrão do sistema da Massatop.

> ### ⚠️ Sobre o cupom
> O sistema imprime **dois tipos** de cupom, e quem decide é você:
>
> - **Com a NFC-e desligada** (padrão): sai um **comprovante interno de venda, sem
>   valor fiscal**, com essa advertência impressa. Não substitui NF-e nem NFC-e.
> - **Com a NFC-e ligada**: a venda é transmitida à SEFAZ-BA e o cupom sai como
>   **DANFE NFC-e**, com chave de acesso, protocolo de autorização e QR Code.
>
> Ligar a NFC-e exige credenciamento da loja na SEFAZ, certificado digital A1 e CSC.
> O passo a passo está em **Sistema → NFC-e / Certificado**, e a seção
> [NFC-e](#-nfc-e--cupom-fiscal-eletrônico) explica cada etapa.

---

## Como rodar no seu computador

1. Extraia a pasta em algum lugar fácil, por exemplo `C:\loja-construcao`
2. Dê **dois cliques em `iniciar.bat`**
   - Na primeira vez ele instala as dependências (demora 1 ou 2 minutos)
   - Depois abre o navegador sozinho em `http://localhost:3000`
3. Entre com **admin / admin** e troque a senha em Configurações

Precisa ter o **Node.js 18 ou mais novo** instalado (https://nodejs.org).

### Atualizando para uma versão nova

Feche a janela preta do servidor, extraia a versão nova por cima da pasta e rode
o `iniciar.bat`. Ele confere biblioteca por biblioteca e instala sozinho o que
for novo — não basta olhar se a pasta `node_modules` existe, porque uma versão
nova pode precisar de uma peça que a antiga não tinha.

O arquivo `loja.db` é onde ficam seus dados: **nunca apague**. Se algo der errado
no meio da atualização, apague só a pasta `node_modules` e rode o `iniciar.bat`.

## Como colocar no Railway

O passo a passo completo, feito para seguir sem conhecimento técnico, está no
arquivo **`SUBIR PARA O RAILWAY.txt`** (enviar o código ao GitHub pelo site,
criar o projeto no Railway, o volume, o domínio, levar o `loja.db` da loja pela
tela de Backup e apontar os computadores para o endereço).

Em resumo:

1. Suba o código ao GitHub (pelo site: *Upload files*), **sem** a pasta
   `node_modules` e **sem** o `loja.db`.
2. No Railway: **New Project → Deploy from GitHub repo** e escolha o repositório.
3. **Adicione um volume** montado em **`/data`**. É o passo que faz os dados
   sobreviverem a cada atualização — a partir da versão 1.14 o sistema **acha o
   volume sozinho** (lê `RAILWAY_VOLUME_MOUNT_PATH`); `DATA_DIR=/data` continua
   funcionando, mas não é mais obrigatório. **Sem volume o sistema nem sobe** —
   ele avisa nos logs em vez de criar um banco vazio que sumiria no deploy seguinte.
4. **Settings → Networking → Generate Domain** para ter o endereço.
5. Entre com `admin` / `admin` (na internet, troca de senha obrigatória) e leve
   o banco da loja em **Configurações → Backup → Restaurar um backup**.

Detalhes técnicos da versão na internet:

- **Healthcheck**: `GET /saude` (configurado no `railway.json`).
- **Porta**: usa `PORT` (injetada pelo Railway); em casa, `3000`.
- **HTTPS**: na internet o sistema redireciona `http → https` sozinho e manda
  cabeçalhos de segurança; o `/saude` fica de fora do redirecionamento.
- **Senha de fábrica**: na internet é obrigatório trocar antes de usar; há
  limite de tentativas de senha (anti–força-bruta).
- **Cache**: as telas vão com `Cache-Control: no-cache`, então **não precisa
  mais de Ctrl+Shift+R** depois de atualizar.
- **Cópia diária**: o sistema guarda uma cópia do banco por dia em `backups/`
  (as 7 últimas), ao lado do `loja.db`.
- **Recuperar acesso na internet**: variável `RESETAR_ADMIN=1` (depois apague-a).

O `deploy.bat` (git push) continua existindo, mas o envio pelo site do GitHub é
mais simples e não depende de configurar o git.

---

## O que tem no sistema

### 🛒 Frente de Caixa (PDV)
- Leitor de código de barras (bipe e o item entra), código interno ou busca por nome
- Digite `3*` antes do código para lançar 3 unidades de uma vez
- Preço e quantidade editáveis na hora, desconto por item e desconto na venda
- Teclas de atalho: `F2` buscar • `F3` cliente • `F4` desconto • `F8` tirar item • `F9` finalizar
- Pagamento misto na mesma venda (dinheiro + PIX + cartão + crediário)
- Troco calculado só sobre o dinheiro — não deixa dar troco em PIX ou cartão
- Cupom abre para impressão automaticamente depois de fechar a venda

### 📦 Produtos e Estoque
- Cadastro com código de barras, NCM, categoria, unidade (UN, SC, M², M³, KG, BR…)
- Cálculo de preço por margem: digita o custo e a margem, o sistema faz o preço
- Produtos que aceitam quantidade fracionada (areia, m² de piso, kg de prego)
- Entrada, saída e ajuste de inventário — **todo movimento fica no histórico**
  (a saída por venda acontece na **entrega**, não no caixa — ver Expedição)
- Alerta de estoque mínimo com sugestão de quanto comprar
- Reajuste de preço em lote, por categoria ou geral

### 👥 Clientes e Crediário
- Cadastro com busca de endereço por CEP
- Limite de crédito com bloqueio automático na venda
- Saldo devedor, total comprado e dias sem comprar calculados na hora
- Parcelas em Contas a Receber, com baixa total ou parcial e estorno

### 📝 Orçamentos
- Monta a proposta como se fosse uma venda: bipa o código, ajusta quantidade e
  preço, dá desconto, escolhe condição de pagamento e prazo de entrega
- **Validade em dias** — a proposta vence sozinha e a lista marca em vermelho
- Impressão em **folha A4**, com os dados da loja, os itens, o total, a data de
  validade e o aviso de que é proposta: **não é documento fiscal, não é venda e
  não reserva mercadoria**
- Botão **Fechar venda** leva o orçamento para a Frente de Caixa mantendo o preço
  prometido ao cliente; se algum preço mudou ou faltar estoque, o sistema avisa antes
- Ao finalizar a venda, o orçamento fica marcado como fechado e guarda o nº do cupom
- **Não mexe em estoque, caixa nem contas** — só a venda mexe
- Vencido pode ser reaberto, e o que não deu certo pode ser cancelado com motivo
- A lista mostra a **taxa de conversão**: quantos orçamentos viraram venda

### 📊 Painel: loja e obras separados (1.24)

No **Painel**, **Vendas de hoje (loja)** e **Vendas do mês (loja)** contam só a
loja (caixa). As obras ficam num cartão próprio, **Obras de hoje** (em laranja),
que totaliza à parte e mostra também o total do mês (a custo). O gráfico dos
últimos 7 dias é só da loja. O **Lucro bruto** segue só da loja (a obra sai a
custo, sem margem). Quem quiser o total junto (loja + obra) tem o relatório
**Vendas do Dia**.

### 👤 Vendas do Dia por vendedor (1.22)

No relatório **Vendas do Dia** agora tem a seção **"Por vendedor (caixa)"**, ao
lado de "Como foi pago": cada vendedor com o número de cupons e o total vendido
no dia, do que mais vendeu para o que menos vendeu. O vendedor é o que estava na
venda (quem registrou, ou o nome escolhido na Frente de Caixa).

### 🔎 Clicar na conta mostra os dados para pagamento (1.21)

Em **Contas a Pagar**, clique em cima de qualquer linha para abrir **"Dados para
pagamento"**: o **código de barras do boleto** e os **dados do PIX** (cada um com
botão **Copiar**), o botão **Ver boleto** (PDF/foto) e um botão **Pagar** que leva
direto pra tela de pagamento. Os botões da linha (Pagar, ✏️, ⧉, 🗑️, 📎) continuam
funcionando normalmente — clicar neles não abre essa janela.

### 💸 Pagar conta mais simples (1.20)

Na tela **Pagar conta** (Contas a Pagar) o campo **Forma** saiu. Ficam
Juros/Multa, Desconto, Valor a pagar e Observação. A opção **"Paguei em
dinheiro — tirar do caixa (lança uma sangria)"** continua, agora **desmarcada
por padrão**: marque só quando o dinheiro saiu da gaveta do caixa, e aí a
sangria é lançada como antes.

### 🧾 Vendas do Dia (1.19)

Menu **Relatórios → Vendas do Dia**. Um resumo de tudo que saiu num dia só,
começando em **hoje** (tem botão **Hoje / Ontem** e escolher a data).

- Cartões no topo: **Vendido no dia** (caixa + obras), **Caixa**, **Obras** e
  **Itens**.
- Tabela **Produtos que saíram no dia**: cada produto com a quantidade e o
  valor, somando o que saiu no **caixa** e o que saiu para as **obras** (os de
  obra levam o 🏗️ e a coluna **Qtd. obra**). Vem ordenado do que mais vendeu
  para o que menos vendeu.
- **Como foi pago** (dinheiro, PIX, cartão…) e as **Saídas para obras**.
- Botão **Imprimir**.
- As **saídas para obras entram no total do dia pelo valor de custo** (o que o
  dono paga à loja), então o "vendido no dia" já conta o que foi para as obras.

### 🏗️ Obras do dono (1.16)

Menu **Operação → Obras**. Controla o material que sai da loja para as obras do
dono e quanto ele deve acertar com a loja.

- Cadastro de **várias obras** (nome, responsável, endereço).
- **Registrar saída de material**: busca o produto e a quantidade; sai a **preço
  de custo** (ajustável item a item); o estoque baixa na hora. Não passa pelo
  caixa nem emite nota — é controle interno.
- Cada obra mostra **retirado (custo)**, **pago** e **saldo a pagar**; o botão
  **Registrar pagamento** abate o saldo.
- **Extrato** imprimível (materiais + pagamentos + saldo) para entregar ao dono.
- **Resumo por material** e estorno de saída (devolve ao estoque) ou de pagamento.
- Acesso: Administrador e Gerente (liberável a outros perfis em *Configurações →
  Perfis → Obras*).

### 💳 Contas a Pagar: boleto e PIX (1.16 / 1.17)

- Ao lançar/editar uma conta, escolha **como vai pagar**: **Boleto** (anexa o PDF
  ou foto — fica guardado no sistema e vai no backup; um 📎 na lista e um botão na
  tela de pagar abrem o boleto) ou **PIX** (guarda os dados do PIX, que aparecem
  com botão **Copiar** na hora de pagar; a conta ganha a etiqueta 🔑 PIX).
- **(1.17)** no Boleto, um campo para digitar/colar o **código de barras (linha
  digitável)**; na hora de pagar ele aparece com botão **Copiar**, para pagar
  pelo app do banco sem abrir o PDF.
- **(1.18)** botão **Duplicar** (⧉) em cada conta: abre o "Lançar conta" já
  preenchido com os dados dela (vencimento no mês seguinte) para repetir contas
  que voltam todo mês; salva como conta nova.

### 📱 Contas a Pagar e celular (1.15)

- **No celular, as tabelas viram cartões**: cada linha vira um cartãozinho com
  o nome do campo ao lado do valor (Fornecedor, Valor, Vencimento…). Nada mais
  corta na tela. No computador continua a tabela normal. Vale para todas as
  listas (Contas a Pagar, Vendas, Produtos, Clientes…)
- **Contas a Pagar — ordenar pela coluna**: no computador, clique no título de
  qualquer coluna para ordenar; clique de novo para inverter
- **Contas a Pagar — agrupar por fornecedor**: botão que junta as contas de
  cada fornecedor, com total e quanto está em aberto com ele; clicar na faixa
  recolhe/abre o grupo
- **Atalho "Este mês" corrigido**: vai do dia 1 ao **último dia do mês** (antes
  parava em hoje), então as contas a vencer ainda neste mês aparecem; "Este ano"
  vai até 31/dez. Vale em todas as telas com os botões de período

### ☁️ Na internet / Backup e restauração (1.14)

- **Pode rodar na internet (Railway)** além do computador da loja — os dois
  computadores passam a usar o mesmo sistema e o mesmo banco. Passo a passo em
  `SUBIR PARA O RAILWAY.txt`
- **Restaurar um backup** (*Configurações → Backup*): troca todos os dados pelos
  de um arquivo `loja.db`/`backup-loja-….db`, depois de **conferir e mostrar** o
  que há dentro (vendas, produtos, última NFC-e, certificado, CSC) e de guardar
  uma cópia do banco atual. É assim que o banco da loja vai para a internet
- **Troca da senha de fábrica obrigatória na internet** + limite de tentativas
  de senha (anti–força-bruta)
- **Cópia diária automática** do banco em `backups/` (as 7 últimas) e um quadro
  em *Backup* mostrando onde os dados estão e o espaço livre
- **Gravação à prova de queda de luz** (o `loja.db` nunca fica pela metade) e o
  sistema **não sobe** sobre um banco vazio/danificado nem sem o volume montado
- **PIX voltou a emitir nota** — correção da rejeição **391** (o PIX passou a
  exigir o mesmo bloco de pagamento do cartão). Reenvie as notas de PIX que
  ficaram rejeitadas

### 🚚 Expedição / Entregas (1.13)

**A venda não baixa o estoque. Quem baixa é a entrega confirmada.** Fechou a venda,
ela entra em *Expedição / Entregas* como "a entregar", com os itens, o endereço do
cliente (do cadastro, ou digitado no caixa) e a previsão. Quando a mercadoria sai e o
cliente recebe, a expedição confirma — e **nesse momento** o estoque baixa, com o
nome de quem recebeu.

- **Entrega parcial**: saiu só uma parte (20 dos 50 sacos)? Informe a quantidade de
  cada item; o resto continua pendente para a próxima viagem. Cada confirmação fica
  registrada (data, usuário, quem recebeu, observação)
- **Cliente leva agora**: no caixa, o campo *Entrega* do pagamento tem a opção
  "Cliente leva agora" — a venda já sai entregue e o estoque baixa na hora. O padrão
  ("Expedição entrega depois") fica em *Configurações → Regras de venda*
- **Romaneio** 🖨️: a folha que vai com a mercadoria — itens, endereço, telefone, o
  que já foi entregue, e linhas para assinatura do motorista e de quem recebeu
- **Estoque reservado**: o que foi vendido e ainda não saiu aparece em Produtos como
  "a entregar · livre". O PDV só deixa vender o que está **livre** (quando "vender
  sem estoque" está bloqueado), para não vender duas vezes a mesma mercadoria. A
  Sugestão de Compra também conta só o livre
- **Cancelar a venda** devolve ao estoque só o que de fato tinha saído
- O cupom avisa *ENTREGA PENDENTE* enquanto a mercadoria não sai; o Painel mostra as
  entregas a fazer e as atrasadas (previsão vencida)
- Quem vê: perfis com *Expedição / Entregas* (Gerente e Estoquista já ganham). O
  caixa também pode confirmar, para o cliente que volta para buscar
- Vendas feitas antes da 1.13 já tinham baixado o estoque: não entram na expedição

### 📥 Entrada de Nota de Compra
- Leia o **XML da NF-e** que o fornecedor manda por e-mail e o sistema faz o resto:
  cadastra o fornecedor, cria ou reconhece os produtos, dá entrada no estoque,
  atualiza o custo e lança as parcelas no Contas a Pagar
- Reconhece o produto por **código de barras, código ou descrição** — na segunda
  compra do mesmo item ele já sabe qual é
- Calcula o **preço de venda pela margem** que você informar, e mostra a prévia
  item por item antes de confirmar
- Avisa se a nota **já teve entrada** (para o estoque não entrar duas vezes) e se
  o destinatário não é o CNPJ da sua loja
- Dá para **desmarcar itens** que não quer lançar
- Histórico de todas as notas que entraram, com o **XML guardado** (botão 📄) —
  notas lançadas antes da versão 1.11 ficam sem o arquivo, só com a chave

#### 📦 Pacote do mês para a contabilidade

Virou o mês, escolha o mês no card **Pacote do mês para a contabilidade** (fim da
tela de Entrada de Nota), clique em **Conferir** e depois em **Baixar**. Sai um ZIP
`contabilidade_AAAA-MM.zip` com:

- `compras/` — o XML de cada NF-e de compra que entrou no mês (pela data de emissão)
- `vendas/` — o XML de cada NFC-e **autorizada** no mês (pela data de autorização,
  só produção); `vendas/canceladas/` tem a nota cancelada e o evento de cancelamento
- `resumo_AAAA-MM.xlsx` — abas Resumo, Compras e Vendas, com chave, valor, protocolo
- `LEIA-ME.txt` — explica ao contador o que é cada coisa e lista as notas de compra
  que ficaram sem XML (anteriores à 1.11), com a chave para baixar no portal

É só encaminhar o ZIP. Nos primeiros 15 dias do mês, o aviso semanal lembra se o
pacote do mês anterior ainda não foi gerado.

### 📊 Importar planilha
- Botão **Importar planilha** em Produtos, Clientes e Fornecedores
- Aceita **.xlsx, .xls e .csv**, e reconhece os nomes de coluna mais comuns sozinho
  (Descrição/Produto/Nome, Preço de venda/Valor de venda, CNPJ/CPF/Documento…)
- Mostra a **prévia antes de importar**: quantas linhas entram, quantas vão ser
  atualizadas e quais têm problema
- Quem já existe é **atualizado, nunca duplicado** — dá para escolher importar só
  os que ainda não existem
- Botão para baixar um **modelo** de planilha já com o cabeçalho certo

### 💳 Recebíveis de Cartão
- Cadastro das **maquininhas** (Cielo, Stone, Rede, PagSeguro…) com a taxa de
  débito, crédito à vista e crédito parcelado, e o prazo de cada uma
- Ao cadastrar, o sistema simula em dinheiro o que a taxa significa numa venda de R$ 1.000
- No PDV, ao lançar cartão, aparece a maquininha e **quanto a loja vai receber de
  fato** antes de confirmar
- Cada venda no cartão vira parcela a receber da operadora, com **bruto, taxa,
  líquido e a data prevista do depósito**
- Baixa uma a uma ou **em lote**, marcando tudo que caiu no extrato do dia
- Marque uma maquininha como **padrão** e nem precisa escolher a cada venda

### 💸 Contas a Pagar
- Fornecedores com CNPJ, contato do vendedor e quanto ainda se deve a cada um
- Categorias de despesa já prontas (energia, aluguel, folha, imposto, mercadoria…)
- Lançamento parcelado: informe o total e o nº de parcelas, o sistema mostra a
  prévia dos vencimentos antes de gravar
- Pagamento com juros/multa e desconto, total ou parcial, com estorno
- Pagou em dinheiro? O sistema oferece **tirar do caixa**, lançando a sangria sozinho
- Alerta de contas vencidas no painel e no menu

### 🔑 Perfis de Acesso
- Em **Configurações → Perfis de acesso** você monta quem vê o quê, marcando
  módulo por módulo numa lista só
- Já vem com 6 perfis prontos: **Administrador, Gerente, Operador de Caixa,
  Vendedor, Financeiro e Estoquista** — pode editar todos, menos o acesso total
  do Administrador
- Além dos módulos, o perfil controla **o que a pessoa pode fazer**: dar desconto,
  alterar o preço no PDV, cancelar venda, excluir cadastros, reajustar preços,
  gerenciar usuários e baixar backup
- O menu esconde o que a pessoa não alcança, e o **painel só mostra os números
  que ela pode ver** — quem cuida do estoque não enxerga o faturamento do dia
- **O bloqueio vale no servidor**, não só na tela: saber o endereço não adianta
- Travas de segurança: o perfil Administrador não perde o acesso total, e o
  sistema não deixa você desativar o último usuário que gerencia usuários

### 🏛️ NFC-e — cupom fiscal eletrônico

A NFC-e (modelo 65) é o cupom fiscal de verdade: o sistema monta o XML, assina com
o certificado digital da loja, transmite à SEFAZ-BA e imprime o DANFE com QR Code.
Tudo fica em **Sistema → NFC-e / Certificado**, que abre com um **passo a passo**
mostrando o que ainda falta.

**Nada disso liga sozinho.** Enquanto a emissão estiver desligada, o sistema segue
imprimindo o cupom interno normalmente.

#### Dois caminhos para transmitir

Em **Sistema → NFC-e → Como transmitir** você escolhe:

| | Direto na SEFAZ | Pela Focus NFe |
|---|---|---|
| Quem assina e transmite | o sistema, com o certificado cadastrado aqui | a Focus, com o certificado cadastrado no painel dela |
| CSC | cadastrado aqui, um par por ambiente | cadastrado no painel da Focus |
| Numeração | do sistema (Série / Próximo número) | da Focus |
| Custo | zero por nota | mensalidade da Focus |
| Quando a SEFAZ muda regra (NT) | o sistema precisa ser atualizado | a Focus cuida |
| O que entra aqui | certificado, CSC, endereços | só os **tokens** (um por ambiente) |

Nos dois casos a venda, o cupom térmico (com QR Code), a lista de notas, o
reenvio e o cancelamento funcionam do mesmo jeito. As notas emitidas pela Focus
ficam marcadas com `focus` na lista, e o XML autorizado é baixado da Focus e
guardado no `loja.db` também.

**Pela Focus, o que precisa estar no painel deles** (`app.focusnfe.com.br`):
a empresa cadastrada com CNPJ, endereço, IE, **certificado A1** e o **CSC de cada
ambiente**. Aqui entram só os tokens que a Focus mostra em *Empresas → Tokens*.
O botão **📡 Testar Focus** confere se o token do ambiente ligado é aceito.

#### O que você precisa antes de ligar

| Item | Onde consegue |
|---|---|
| Credenciamento para NFC-e | Portal da SEFAZ-BA — normalmente o contador pede |
| Certificado digital **A1** (arquivo `.pfx`) | Certificadora (o mesmo que o contador usa) |
| Inscrição estadual | Já deve estar no cadastro da loja |
| **CSC** e **ID do CSC** | Portal da SEFAZ-BA, depois de credenciado |

O CSC (também chamado de *Token NFC-e*) é um código secreto que assina o QR Code.
São **dois códigos diferentes**: um para homologação e outro para produção.

#### O caminho certo para começar

1. Cadastre o certificado A1 e a senha dele
2. Preencha inscrição estadual, código IBGE do município e CSC
3. Deixe o ambiente em **Homologação** e clique em **📡 Testar SEFAZ**
4. Ligue a emissão e faça uma venda de teste — a nota sai com a tarja
   *"EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL"*
5. Só depois que uma nota de teste for autorizada, troque o CSC pelo de produção
   e mude o ambiente para **Produção**

Fazer o contrário — ir direto para produção — significa descobrir os erros de
cadastro com o cliente esperando no balcão.

#### No dia a dia

- **CPF na nota**: o PDV ganha o campo *CPF/CNPJ na nota* (tecla **F7**). O sistema
  confere o dígito na hora — CPF errado faz a SEFAZ rejeitar a nota inteira
- **Ao fechar a venda** o sistema emite a nota (sozinho ou perguntando, você escolhe)
  e só então imprime, para o cupom já sair com a chave e o QR Code
- **Venda no cartão (débito ou crédito) emite a NFC-e sem perguntar** (1.12): a
  operadora informa tudo à SEFAZ, então a nota é obrigatória. Dinheiro e PIX seguem a
  regra escolhida em *Ao fechar a venda* (perguntar ou emitir sozinho). Se a nota do
  cartão falhar, o aviso no caixa fica vermelho e a venda aparece no aviso semanal como
  "venda no cartão sem nota" — reenvie no mesmo dia
- **Quem vende, emite**: todo perfil com acesso à Frente de Caixa tem a ação "Emitir
  NFC-e" (a 1.12 ajusta os perfis antigos sozinha)
- **Se a SEFAZ estiver fora do ar ou a internet cair, a venda não para.** Ela é
  gravada, o cupom sai, e a nota fica registrada como pendente para reenviar
- **Cancelamento** pela lista de notas emitidas, com justificativa de no mínimo
  15 letras (exigência da SEFAZ) e dentro do prazo que o estado permite
- **XML de cada nota** disponível para download — a lei manda guardar por 5 anos

#### Imposto por produto

Cada produto tem **NCM, CEST, CFOP, origem e CSOSN** (em *Produtos → Dados fiscais
da NFC-e*). Em branco, ele usa o padrão da loja. Preencha só quando o produto tiver
tributação diferente — cimento, por exemplo, costuma ser substituição tributária
(**CSOSN 500**), enquanto o restante fica no **102**.

#### 🏷️ NCM dos produtos (1.12)

O NCM é o código fiscal do produto e vai em cada item da NFC-e. Produto sem NCM sai
com o **NCM padrão da loja** — um código genérico que passa na SEFAZ mas não descreve
o produto, e é o tipo de coisa que a fiscalização cobra. Código que não existe derruba
a nota (rejeição 778).

Em **Produtos → 🏷️ NCM dos produtos** o sistema mostra quem está sem NCM (os vendidos
primeiro) e **sugere** um código, nesta ordem de confiança:

1. **nota de compra** — o NCM que o fornecedor declarou na NF-e daquele produto;
2. **produto parecido** — outro produto seu, com a mesma palavra-chave, já tem NCM;
3. **palavra-chave** — regras feitas para loja de material de construção (cimento,
   argamassa, tubo de PVC, torneira, fio, disjuntor, tinta, prego, telha…).

Marque as sugestões que conferem e clique em **Aplicar**. Cada sugestão mostra a
descrição oficial do código — sugestão é sugestão, confira antes. Quem não teve
sugestão, use o 🔍 da linha: a busca procura por palavras na tabela oficial (10.440
códigos). O botão **Planilha para o contador** gera um Excel com o NCM atual e as
sugestões; o contador corrige a coluna NCM e você importa de volta em *Importar
planilha* (o sistema casa pelo código e só aceita NCM que exista).

O cadastro do produto também ganhou a busca (🔍 ao lado do NCM) e mostra a descrição
do código digitado; NCM que não existe não é gravado.

Tabela usada: validade dos códigos da tabela NCM × uTrib do portal da NF-e
(01/09/2022), descrições da tabela de 2015 com complementos escritos à mão para as
subposições criadas depois. Códigos criados após set/2022 não constam — raro em
material de construção, mas se a SEFAZ aceitar um código que a busca não acha, avise.

Os dados fiscais são **copiados para a venda no momento em que ela acontece**. Se
o CSOSN do cadastro mudar depois, a nota emitida ontem continua conferindo com o
que foi transmitido.

#### O que confirmar com o contador

Este sistema monta a nota; quem responde pelo imposto é o contador. Vale conferir
com ele, antes de ir para produção: **CFOP**, **CSOSN**, **CST de PIS/COFINS**,
**NCM** dos produtos e se algum item é substituição tributária.

#### Versão do QR Code

A tela deixa escolher entre **versão 2** (a que usa o CSC, hoje a mais aceita) e
**versão 3** (dispensa o CSC, introduzida pela NT 2025.001). Confirme com o
contador ou no portal da SEFAZ-BA qual está valendo antes de ligar em produção.

#### Endereços da SEFAZ

**A Bahia não tem autorizador próprio de NFC-e.** Quem recebe e autoriza a NFC-e
baiana é a **SEFAZ Virtual do Rio Grande do Sul (SVRS)** — em homologação e em
produção. O `nfe.sefaz.ba.gov.br` atende só NF-e modelo 55; mandar a NFC-e para
lá devolve a rejeição **702 — NFC-e não é aceita pela UF do Emitente**. Da Bahia
ficam apenas as páginas de consulta e de QR Code, que o consumidor abre no celular.

Os endereços já vêm preenchidos certos e ficam editáveis em **🌐 Endereços da
SEFAZ**. A SEFAZ muda isso de tempos em tempos — se der erro de conexão, confira
no portal antes de mexer em qualquer outra coisa.

#### Nota de teste (homologação)

Em homologação a SEFAZ exige que a **descrição do primeiro item** seja exatamente
`NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL` — senão vem a
rejeição **373**. O sistema faz essa troca sozinho no XML, só em homologação; o
cupom impresso e o cadastro continuam com o produto de verdade, e em produção sai
a descrição real. Não precisa de produto de teste no catálogo.

#### 📣 Aviso semanal: compras com nota × cartão × NFC-e emitidas (1.11)

Uma vez por semana (a partir do dia escolhido, segunda por padrão), quem tem acesso
à tela de NFC-e vê ao abrir o sistema um quadro do mês: quanto entrou de **compra com
nota**, quanto **passou no cartão** (débito + crédito, mais o crediário recebido no
cartão), quanto de **NFC-e foi emitido** e o **mínimo a emitir**.

A regra do mínimo: **cartão + folga** (3% por padrão). A operadora de cartão informa
à SEFAZ tudo que passou na maquininha, então a venda com nota tem que cobrir pelo menos
isso — 30 mil no cartão com 3% de folga pedem 30,9 mil de nota no mês. O quadro diz
quanto falta, em quantos dias, e quantas vendas do mês ainda não têm NFC-e (dá para
emitir pela tela de Vendas / Cupons). PIX pode ser somado ao mínimo por opção.

Só nota de **produção** conta. O mesmo quadro fica na tela **NFC-e / Certificado**,
com seletor de mês e a regra ajustável (folga, PIX, dia da semana, ligar/desligar).

#### Reenviar uma nota rejeitada

Em **Sistema → NFC-e**, cada nota rejeitada (ou que deu erro de comunicação) tem
o botão **🔁 Reenviar**: o sistema monta a nota de novo com os dados atuais da
venda e transmite. O botão **📄 XML** mostra exatamente o que foi enviado — é o
que o suporte pede quando a SEFAZ rejeita.

#### Rejeição não gasta número

Quando a SEFAZ **rejeita** uma nota, ela nunca registrou aquele número. Por isso o
reenvio da mesma venda usa o mesmo número, em vez de furar a sequência a cada
tentativa — cada buraco em produção teria que ser inutilizado depois, um por um.
Nota que deu **erro de comunicação** (a SEFAZ não respondeu) não entra nessa regra:
ela pode ter recebido e autorizado sem o sistema saber, e aí reusar o número daria
duplicidade. Essa fica registrada para inutilização.

#### CSC: qual é o ID e qual é o código

O portal da SEFAZ entrega dois valores. O **ID** é um número curto (`000001`,
`000002`…) e vai dentro do QR Code, sem zeros à esquerda. O **CSC** é o código
longo, de letras e números, que nunca sai do sistema — só entra no cálculo do
hash. Trocar os dois de campo é o erro mais comum: a tela e o servidor recusam
na hora, porque gravado errado a SEFAZ derruba a nota no schema (225) ou não
reconhece o ID (462).

**Os hífens fazem parte do CSC.** O portal da SEFAZ-BA mostra o código no formato
`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (36 caracteres) e a SEFAZ calcula o hash do
QR Code com ele inteiro. Digite exatamente como aparece lá — mesmas letras,
maiúsculas e minúsculas, com os hífens, sem espaço. Se o hash não bater, a SEFAZ
responde **464 — Hash do QR Code difere do calculado**: ela reconheceu o ID, mas o
código gravado não é o dela. (Da 1.9.4 à 1.10.1 o sistema tirava os hífens ao gravar,
e era exatamente isso que dava 464; a 1.10.2 devolve os hífens aos CSCs que foram
gravados assim, na primeira abertura.) A tela mostra, embaixo de cada campo, quantos
caracteres o CSC guardado tem e se tem hífens — dá para conferir com o portal sem
ver o código.

Homologação e produção têm **CSC e ID diferentes**. Por isso a tela tem **duas
colunas** — cadastre os dois pares e o sistema usa o certo conforme o Ambiente
ligado. Não há nada para trocar na mão ao virar para produção.

**O ID é um campo separado, e é o mais esquecido.** Ele vem do portal como
"Identificador do CSC" (normalmente 1). Desde a 1.12 o sistema não grava o código sem
o ID, e a tela avisa "FALTA O ID" embaixo do campo quando o código está gravado e o ID
não. Tudo isso fica no `loja.db`: ao instalar o sistema em outro computador, o CSC e o
ID precisam ser cadastrados lá também (ou leve o banco junto).

#### Versão do QR Code

**Versão 2** usa o CSC e é a que todo emissor do país usa há anos — é a
recomendada. **Versão 3** (NT 2025.001, em vigor desde 09/2025) dispensa o CSC
no modo normal: o QR Code é só `chave|3|ambiente`. Nesta versão do sistema a
versão 3 **não funciona em contingência offline** (exige assinatura dos
parâmetros, que não está implementada); a tela impede ligar as duas juntas.

#### Código de barras (GTIN)

Na nota, o código de barras do produto só vai se for um GTIN de verdade: 8, 12,
13 ou 14 dígitos **com o dígito verificador certo**. Código inventado — um número
interno de 13 dígitos, por exemplo — sai como `SEM GTIN`, porque a SEFAZ rejeitaria
a nota inteira por causa dele (rejeição 883). Se mesmo assim vier a rejeição
**882** ("GTIN sem cadastro"), é código que existe mas o fabricante não registrou
no cadastro nacional: apague o código de barras daquele produto e reenvie.

#### Reforma tributária (IBS/CBS) — atenção para janeiro de 2027

A NT 2025.002 criou os campos de IBS e CBS na NF-e e na NFC-e. Para o **regime
normal** a SEFAZ rejeita nota sem esses campos desde 03/08/2026. Para o **Simples
Nacional** (que é o caso da loja) a exigência começa em **04/01/2027** — e a NT
manda **não** preencher antes disso. Ou seja: em 2026 a nota sai como está; em
janeiro de 2027 o sistema precisa ser atualizado, senão a rejeição **1115** trava
o caixa. As regras exatas para o Simples ainda vão sair em NT própria.

#### Antes de virar para produção

1. Emita **uma nota de teste autorizada** em homologação.
2. Troque o **CSC** para o de produção (são diferentes).
3. Volte o **Próximo número** para **1** — a numeração de homologação e a de
   produção são independentes.
4. Aí sim mude o **Ambiente** para produção.

Em produção a nota vale desde a primeira, e o cancelamento só é aceito em até
**30 minutos** depois da autorização.

### 🖨️ Impressora
- Configuração em **Configurações → Impressora e cupom**, já vem ajustada para a
  **Epson TM-T20** (térmica 80 mm)
- Largura da bobina, tamanho da fonte, margem, número de vias, linhas de avanço
  antes do corte, mensagem no topo e no rodapé
- Escolher se o cupom já abre a impressão ao fechar a venda
- **A janela do cupom nunca fecha sozinha.** Ela só manda imprimir; quem fecha é
  o operador, no botão Fechar. Cancelou a impressão? O cupom continua na tela,
  com o botão Imprimir ali para mandar de novo
- Botão **Imprimir teste** com uma régua de largura: se ela couber numa linha só,
  a configuração está certa
- Guia passo a passo do driver da TM-T20 no Windows dentro da própria tela
  (papel 80 mm, corte automático, gaveta de dinheiro)
- `atalho-pdv.bat` abre o navegador em modo de impressão direta — o cupom sai na
  impressora padrão sem caixa de diálogo

### ⚖️ Fluxo de Caixa
- O que entra (**crediário + cartão**, em colunas separadas) contra o que sai
  (contas a pagar), por prazo: vencidos, hoje, 7, 15, 30, 60 e acima
- Mês a mês com saldo do mês e saldo acumulado — dá para ver com antecedência
  em que mês o caixa aperta

### 💵 Caixa
- Abertura com fundo de troco, sangria e suprimento
- Fechamento comparando o dinheiro contado com o esperado e registrando a diferença
- Resumo por forma de pagamento e histórico de todos os caixas

### 📊 Relatórios
- Vendas por período, por forma de pagamento e por vendedor, com lucro e margem
- Curva ABC de produtos (quais itens sustentam o faturamento) e total por categoria
- Ranking de clientes com ticket médio e participação
- Despesas por categoria, por fornecedor e por mês, com o **resultado da loja**
  (lucro bruto das vendas menos as despesas) e quanto do faturamento vira despesa
- **Sugestão de Compra** (1.11): os mais vendidos agrupados por **fornecedor ›
  categoria (ou marca/modelo) › produto**, e quanto comprar de cada um pela
  **velocidade de venda** — veja abaixo

### 🛒 Sugestão de Compra — comprar pela velocidade, não pelo achismo

Para cada produto o sistema olha o que saiu no período (30, 60, 90, 180 dias ou um
ano) e calcula:

- **velocidade** = quantidade vendida ÷ dias (um produto cadastrado há menos tempo que
  o período é medido pelos dias em que existe, no mínimo 7)
- **dias de estoque** = estoque atual ÷ velocidade — quanto tempo o que está na
  prateleira aguenta no ritmo atual
- **comprar** = velocidade × (dias de entrega + dias de cobertura) − estoque atual,
  nunca abaixo do **estoque mínimo** do cadastro. "Entrega" é quanto o fornecedor
  leva para entregar; "cobertura" é para quantos dias você quer ter estoque

Cada produto recebe uma situação: **FALTA** (zerado e vendendo), **URGENTE** (acaba
antes de a entrega chegar), **comprar**, **ok**, **excesso** (estoque para mais que o
dobro do necessário — dinheiro parado) e **parado** (tem estoque e não vendeu nada no
período: não compre, faça promoção ou devolva).

A tela mostra os mais vendidos de todos, depois um bloco por fornecedor com o total
vendido, o custo do pedido sugerido e os urgentes. O botão **Planilha** gera um Excel
com uma aba geral, um resumo por fornecedor, **uma aba por fornecedor só com o que
comprar** (é o pedido, pronto para mandar) e o estoque parado.

O campo **Marca / modelo** do produto (novo na 1.11) permite agrupar por Fornecedor ›
Marca › Produto; em branco, o agrupamento usa a categoria. A planilha de importação
aceita a coluna "marca" (ou "modelo").

Limites que valem saber: a velocidade vem das vendas registradas — se o produto ficou
sem estoque parte do período, a demanda real era maior que a medida; e a sugestão não
conhece lote mínimo nem embalagem do fornecedor (arredonde na hora de pedir).

---

## Detalhes que vale saber

**Validade do orçamento conta dias corridos.** "Vale por 30 dias" é 30 dias, não
"até o mês que vem" — diferente da regra das parcelas abaixo, que é de mês em mês
de propósito.

**Vencimento das parcelas.** Vale para o crediário e para as contas a pagar:
prazo múltiplo de 30 anda de mês em mês mantendo o dia — é como a loja cobra e
paga ("todo dia 10"). Vendeu dia 10/09 em 3x? Vence 10/09, 10/10 e 10/11. Se o
dia não existir no mês de destino, cai no último dia (31/01 + 30 = 28/02).
Qualquer outro prazo soma dias corridos.

**Pagar conta em dinheiro.** Ao marcar "tirar o dinheiro do caixa", o sistema
lança uma sangria automática com o nome do fornecedor no motivo, e recusa se não
houver esse dinheiro na gaveta. Se você estornar o pagamento depois, o dinheiro
**não** volta sozinho ao caixa — lance um suprimento para acertar (o sistema avisa).

**Cada tipo de venda vai para um lugar — de propósito.**

| Forma de pagamento | Onde aparece |
|---|---|
| Dinheiro, PIX | Caixa (dinheiro na gaveta / PIX na conta) |
| Cartão débito e crédito | **Recebíveis de Cartão** — a maquininha ainda vai depositar |
| Crediário | **Contas a Receber** — o cliente ficou devendo |

O **Contas a Receber** só tem crediário: é o que o *cliente* deve. O que a
*operadora do cartão* deve fica em Recebíveis de Cartão, com a taxa já
descontada. Se a mesma venda entrasse em dois lugares, ela seria contada
duas vezes no faturamento.

Cartão só vira recebível se houver maquininha cadastrada. Sem cadastro, a venda
no cartão é tratada como paga na hora — que é o comportamento de quem ainda não
configurou as taxas.

**A TM-T20 não é impressora fiscal.** Ela é uma térmica não fiscal, que é
exatamente o que este sistema precisa. Impressora fiscal (ECF) é outro
equipamento, descontinuado no Brasil; o substituto é a NFC-e transmitida à SEFAZ.
Quem corta o papel e abre a gaveta é o **driver** da Epson, não o sistema —
por isso os passos 3 e 4 do guia na tela de Configurações.

**Divisão das parcelas.** A última parcela absorve os centavos da divisão, então a
soma sempre bate com o total exato da venda.

**Cancelamento de venda.** Devolve o estoque, apaga as parcelas do crediário e fica
registrado no log com o motivo. Venda com parcela já recebida não cancela — é
preciso estornar o recebimento antes.

**Exclusões.** Produto ou cliente que já tem movimento é apenas **inativado**, nunca
apagado, para não perder o histórico.

**Vender sem estoque.** Em Configurações dá para escolher entre deixar o saldo ficar
negativo (padrão, útil para venda de areia e brita que chegam depois) ou bloquear a venda.

**Backup.** Em Configurações → Backup você baixa o arquivo do banco inteiro.
Faça isso pelo menos uma vez por semana e guarde fora do computador da loja.
Para restaurar, é só substituir o `loja.db` pelo arquivo salvo.

**Perfis.** `admin` vê tudo e mexe em usuários, configurações e backup.
`operador` vende, mexe em estoque, clientes e vê relatórios.

**A hora do computador importa para a NFC-e.** A SEFAZ compara a hora de emissão
com a dela e rejeita nota com atraso demais (erro 228). Se o relógio do PC da loja
estiver errado, as notas param de sair — vale deixar o Windows sincronizando a hora
pela internet.

**O certificado passa a morar no loja.db.** Depois de cadastrado, o backup do banco
contém o certificado digital da empresa. Guarde esse arquivo com o mesmo cuidado que
você guarda o `.pfx`: quem tem o `loja.db` pode assinar em nome da RVL.

**Janela aberta por cima fica na frente.** Buscar produto de dentro do orçamento,
cadastrar cliente de dentro da busca de cliente — a janela nova sempre aparece na
frente da anterior, e o Esc fecha a de cima. Antes todas dividiam a mesma altura
e a busca podia ficar escondida atrás.

---

## Arquivos

```
loja-construcao/
├── server.js              backend inteiro (API + cupom)
├── fiscal.js              NFC-e: certificado, XML, assinatura, QR Code, SEFAZ
├── pacote.js              ZIP mensal para a contabilidade (XMLs + planilha-resumo)
├── ncm.js                 tabela NCM, busca e sugestao de NCM por descricao
│   (expedicao: tabelas entregas/entrega_itens/entrega_movs no server.js; tela em public/js/expedicao.js)
├── dados/ncm.json         os 10.440 codigos NCM com descricao
├── loja.db                banco de dados (criado no primeiro uso)
├── package.json
├── iniciar.bat            roda o sistema no computador da loja
├── atalho-pdv.bat         abre o PDV com impressao direta na TM-T20
├── deploy.bat             publica no Railway
└── public/
    ├── index.html         todas as telas
    ├── css/estilo.css
    └── js/
        ├── core.js        sessão, navegação, painel, configurações
        ├── pdv.js         frente de caixa
        ├── cadastros.js   produtos, categorias, estoque, clientes
        ├── operacao.js    vendas, caixa, contas a receber
        ├── relatorios.js  vendas, curva ABC, clientes
        ├── financeiro.js  contas a pagar, fornecedores, fluxo de caixa, despesas
        ├── cartao.js      maquininhas e recebiveis de cartao
        ├── perfis.js      perfis de acesso e permissoes
        ├── entrada.js     entrada de nota (XML) e importacao de planilha
        ├── orcamento.js   orcamentos e conversao em venda
        └── fiscal.js      certificado digital, NFC-e e notas emitidas
```

O sistema já vem com **30 produtos de exemplo** de loja de material de construção,
só para você navegar e testar. Pode excluir todos em Cadastros → Produtos.

---

## Sobre a emissão de NFC-e — leia antes de ir para produção

A NFC-e deste sistema fala **direto com a SEFAZ**, sem intermediário: monta o XML
do layout 4.00, assina com o certificado A1 e transmite. Isso significa que não há
mensalidade de gateway, e também que **o teste final tem que ser feito por você**,
no ambiente de homologação da SEFAZ-BA.

Foi testado aqui, com 150 verificações automáticas, tudo que dá para testar sem a
SEFAZ real: a chave de acesso e seu dígito verificador (conferido contra exemplo
publicado), a montagem do XML campo a campo, a assinatura digital (verificada
criptograficamente, inclusive que adulterar um valor a quebra), o hash do QR Code,
o rateio do desconto, o comportamento em rejeição e em queda de internet, e o
caminho inteiro contra um servidor que responde igual à SEFAZ.

O que **só o ambiente de homologação da SEFAZ-BA pode dizer** é se ela aceita a
nota do jeito que a sua loja está cadastrada — CFOP, CSOSN, credenciamento, CSC.
Por isso o passo 4 do roteiro acima não é formalidade: é o teste que vale.

Se a SEFAZ rejeitar, a mensagem aparece traduzida na tela (por exemplo, *"a loja
não está credenciada para emitir NFC-e"* em vez de só `cStat 338`), com o código
original junto para o contador entender.

---

## Arquivos de teste (não vão para a loja)

O sistema é acompanhado de 13 suítes automáticas com 682 verificações, incluindo
uma **SEFAZ de mentira** que responde com os mesmos códigos da verdadeira. Elas
ficam fora do pacote da loja — servem para quem for mexer no código.
