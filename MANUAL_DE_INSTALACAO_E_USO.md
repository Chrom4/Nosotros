# No$otros — Manual Completo de Instalação, Configuração e Uso

> **Aplicativo Mobile de Gestão Financeira Doméstica e Pessoal Exclusivo para o Casal**  
> *100% Offline-First • Criptografia de Ponta a Ponta • Transparência e Harmonia Financeira*

---

## 1. Visão Geral e Princípios Arquiteturais

O **No$otros** foi desenvolvido especificamente para casais que buscam gerir sua vida financeira com total transparência, autonomia e segurança.

- **Arquitetura 100% Offline-First:** Toda operação de leitura e gravação ocorre instantaneamente no banco de dados local do seu aparelho (`expo-sqlite` com SQLCipher). O aplicativo funciona perfeitamente sem internet (em viagens, voos ou áreas sem cobertura).
- **Sincronização P2P/Cloud via HLC:** Quando a conexão à internet é restabelecida, os dados são sincronizados com o Supabase utilizando um relógio lógico híbrido (*Hybrid Logical Clock - HLC*), garantindo que nenhuma transação de nenhum dos dois seja perdida ou sobrescrita incorretamente.
- **Segurança e Privacidade Absoluta:**
  - Banco local criptografado com chave AES-256 no hardware seguro (`expo-secure-store`).
  - Bloqueio biométrico automático por tempo de inatividade.
  - Backup externo no Google Drive criptografado com `AES-256-GCM` derivado da Passphrase do casal via PBKDF2 (210.000 iterações).
  - Sem telemetria invasiva ou bibliotecas terceiras de rastreamento.

---

## 2. Pré-requisitos para Compilação e Deploy

Para gerar o aplicativo e configurar o ambiente de nuvem do casal:

1. **Node.js e Yarn:** Node v20+ e Yarn v1.22+.
2. **Conta Expo / EAS CLI:** Uma conta no [expo.dev](https://expo.dev) para compilar os pacotes Android na nuvem.
3. **Projeto Supabase:** Um projeto Supabase configurado com as migrações SQL aplicadas (`supabase/migrations/`).
4. **Google Cloud Console:** Projeto com as APIs *Google Drive API* e *Google Calendar API* ativadas, com credenciais OAuth configuradas para Android.

---

## 3. Passo a Passo de Compilação (EAS Build)

### 3.1. Autenticação no Expo EAS
No terminal da sua máquina de desenvolvimento:
```bash
npx eas login
```
Faça login com sua conta Expo.

### 3.2. Configurar Variáveis de Ambiente e Segredos
Configure as variáveis de produção no painel do Expo EAS ou via linha de comando:
```bash
eas secret:create --name EXPO_PUBLIC_SUPABASE_URL --value "https://seu-projeto.supabase.co" --type string
eas secret:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "sua-chave-anon" --type string
eas secret:create --name EXPO_PUBLIC_GOOGLE_CLIENT_ID --value "seu-client-id.apps.googleusercontent.com" --type string
```

### 3.3. Gerar o APK de Instalação Direta (Perfil `preview`)
O perfil `preview` compila um arquivo `.apk` pronto para ser instalado diretamente nos celulares do casal via download ou cabo USB (sem precisar da Google Play Store):
```bash
yarn build:preview
```
*(Ou execute `eas build --platform android --profile preview`)*

Ao concluir, o EAS disponibilizará um link com QR Code para download do APK diretamente no celular.

### 3.4. Gerar o Pacote de Produção para Google Play (Perfil `production`)
Para publicar o app na Google Play Store como Android App Bundle (`.aab`):
```bash
yarn build:prod
```

---

## 4. Guia de Instalação e Primeiro Acesso nos Dispositivos

### Passo 1: Instalação do APK no Smartphone 1 (Parceiro A)
1. Baixe o APK gerado no EAS e toque no arquivo para instalar.
2. Se o Android solicitar permissão para "Instalar apps de fontes desconhecidas", conceda a permissão ao seu navegador ou gerenciador de arquivos.
3. Abra o app **No$otros**.
4. Autorize a permissão biométrica (impressão digital ou reconhecimento facial).

### Passo 2: Criação do Casal (*Household*) pelo Parceiro A
1. Na tela inicial, selecione **Criar Novo Casal**.
2. Digite o nome do casal (ex.: *"Nosso Lar"*).
3. Defina a **Passphrase Mestra do Casal**.
   > ⚠️ **Atenção Máxima:** Esta frase secreta é usada para criptografar os backups no Google Drive. Guardem-na em um local seguro (gerenciador de senhas ou anotação física segura).
4. O app exibirá um **Código de Convite** de 6 dígitos alfanuméricos (com validade de 48 horas).
5. Envie este código para o Parceiro B (via WhatsApp, mensagem ou pessoalmente).

### Passo 3: Pareamento no Smartphone 2 (Parceiro B)
1. Instale o APK no aparelho do Parceiro B.
2. Abra o app e selecione **Entrar com Convite**.
3. Digite o código de 6 dígitos fornecido pelo Parceiro A.
4. Digite a mesma **Passphrase Mestra do Casal**.
5. Pronto! Ambos os aparelhos estarão agora pareados e sincronizados com a mesma base doméstica compartilhada.

---

## 5. Manual de Uso das Funcionalidades

### 5.1. Contextos Financeiros (Minhas vs Nossas)
No topo das telas principais, você encontra o seletor de contexto:
- **Individual (Eu):** Exibe apenas as contas, cartões e despesas particulares do usuário ativo.
- **Compartilhado (Casal):** Exibe as despesas conjuntas do casal (aluguel, mercado, contas de consumo).
- **Consolidado (Todos):** Visão completa e transparente da saúde financeira da família.

### 5.2. Regra Contábil de Aportes Automáticos (DEC-02)
Se um dos parceiros pagar uma despesa do casal usando sua conta bancária particular ou seu cartão de crédito individual:
- O sistema calcula automaticamente esse pagamento como um **Aporte / Contribuição** para as despesas comuns.
- O Dashboard do Casal exibe o balanço de contribuições de cada um de forma clara e visual, evitando atritos e planilhas paralelas de acerto de contas.

### 5.3. Lançamento Rápido de Transações
Toque no botão central `+` para abrir a modal de transação rápida:
1. **Valor:** Insira o valor em centavos.
2. **Tipo:**
   - *Despesa:* Reduz o saldo da conta selecionada.
   - *Receita:* Aumenta o saldo da conta selecionada.
   - *Compra no Cartão:* Aloca o valor na fatura aberta do cartão sem diminuir o saldo da conta bancária imediatamente.
   - *Transferência:* Move dinheiro entre contas do casal sem gerar despesa ou receita falsa.
3. **Categoria:** Selecione a categoria (ex.: Alimentação, Moradia, Lazer).
4. **Contexto:** Marque se a despesa é Pessoal ou Conjunta.

### 5.4. Cartões de Crédito e Faturas (DEC-01)
- Cada cartão de crédito possui seu dia de fechamento e dia de vencimento.
- Ao lançar compras parceladas, o aplicativo faz a divisão exata dos centavos, alocando o resto na **1ª parcela**.
- O impacto no orçamento financeiro (Regime de Caixa) ocorre no momento do **Pagamento da Fatura**.
- Ao pagar a fatura: o saldo da conta corrente é debitado e a dívida do cartão é quitada sem duplicar as despesas das compras já registradas.

### 5.5. Recorrências Inteligentes e Google Agenda
- Cadastre contas fixas mensais (aluguel, condomínio, internet, salários).
- O motor de recorrências gera as transações de forma determinística via `UUIDv5`, impedindo que os dois celulares gerem duplicatas da mesma conta quando estiverem offline.
- Na aba de Configurações, ative a integração com o **Google Agenda** para receber lembretes dos dias de vencimento diretamente no calendário compartilhado do casal.

### 5.6. Backup Criptografado no Google Drive
- Acesse **Configurações > Backup & Nuvem**.
- Toque em **Realizar Backup Agora**.
- O arquivo de banco de dados é exportado, criptografado com `AES-256-GCM` utilizando a Passphrase do casal, e salvo de forma invisível e segura no `appDataFolder` do Google Drive.
- Em caso de troca ou perda de aparelho, basta instalar o app, conectar a conta Google, informar a Passphrase e selecionar **Restaurar Backup**.

---

## 6. Procedimentos de Manutenção e Diagnóstico

### Auditoria de Segurança e Hardening
A qualquer momento, os desenvolvedores ou auditores podem rodar no terminal:
```bash
yarn security:audit
```
Isso assegura que não existam logs de dados confidenciais ou dependências incompatíveis no código-fonte.

### Execução da Suíte Completa de Testes
```bash
yarn test
```
Executa os 107 testes automatizados de ponta a ponta (invariantes contábeis, motor de sincronização HLC, RLS do Supabase, criptografia de backup e regras de parcelamento).

### Verificação de Tipos e Linter
```bash
yarn typecheck
yarn lint
```
Ambos devem sempre reportar 0 erros antes de qualquer geração de novo build.
