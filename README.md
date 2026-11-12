# No$otros — Gestão Financeira Doméstica & Pessoal para o Casal

> **Aplicativo Mobile Android 100% Offline-First • Sincronização Criptografada • Transparência Financeira do Casal**

O **No$otros** é um aplicativo financeiro projetado exclusivamente para a vida a dois (limite estrito de 2 membros por Lar). Ele elimina planilhas manuais e conflitos financeiros, oferecendo transparência total, clareza sobre quem pagou o quê e equilíbrio financeiro em tempo real — funcionando perfeitamente mesmo sem internet.

---

## 📱 Principais Características

- **100% Offline-First:** Toda operação de leitura e gravação ocorre instantaneamente no banco de dados local criptografado no aparelho (`expo-sqlite` com SQLCipher AES-256). O app funciona sem sinal de rede em qualquer lugar.
- **Sincronização com Relógio Lógico Híbrido (HLC):** Ao reconectar à internet, os lançamentos de ambos os celulares são sincronizados via Supabase sem sobrescrever dados do parceiro.
- **Divisão Inteligente & Aportes Automáticos:** Se um dos parceiros paga uma conta do casal (ex.: aluguel, mercado) usando sua conta bancária pessoal, o app registra automaticamente o aporte e calcula o saldo de acerto entre os dois.
- **Segurança de Ponta a Ponta:**
  - Banco local protegido por chave de 256 bits no hardware seguro (`expo-secure-store`).
  - Bloqueio biométrico automático por inatividade.
  - Backup externo no Google Drive criptografado com `AES-256-GCM` derivado da Passphrase do casal via PBKDF2 (210.000 iterações).
  - Sem rastreadores ou anúncios.

---

## 🧭 Como Usar o No$otros (Tutorial Passo a Passo)

### 1. Pareamento Inicial do Casal

O aplicativo foi desenhado para ligar dois celulares a um único espaço doméstico compartilhado:

1. **Parceiro A (Fundador):**
   - Abre o app e cria a conta com e-mail e senha.
   - Na tela inicial, seleciona **Criar Novo Lar**, informa o nome do lar (ex.: *"Nosso Lar"*) e seu nome de exibição.
   - Define a **Passphrase Mestra do Casal** (guarde esta frase com segurança; ela é a chave para os backups criptografados).
   - O app gera um **Código de Convite de 8 dígitos** (válido por 48 horas).
   - Envie este código para o Parceiro B.

2. **Parceiro B (Parceiro):**
   - Instala o app no seu smartphone e cria sua conta.
   - Na tela inicial, seleciona **Entrar com Convite**.
   - Digita o código de 8 dígitos recebido e seu nome de exibição.
   - Insere a mesma **Passphrase Mestra do Casal**.
   - Pronto! Os dois celulares passam a compartilhar o mesmo espaço doméstico e sincronizar em tempo real.

---

### 2. Contextos Financeiros (Eu vs Nós vs Tudo)

No topo do Dashboard e dos Lançamentos, você encontra a barra seletora de contexto:
- **Individual (Eu):** Exibe exclusivamente as suas contas, cartões e despesas particulares.
- **Compartilhado (Nós):** Exibe apenas as contas, faturas e despesas conjuntas da casa (aluguel, condomínio, supermercado).
- **Consolidado (Tudo):** Visão completa da saúde financeira somada da família.

---

### 3. Navegação pelas Abas Inferiores

| Aba | Nome | O que faz |
| :--- | :--- | :--- |
| 📊 | **Início** | Dashboard executivo com patrimônio líquido consolidado, evolução gráfica mês a mês, controle de orçamentos por categoria e card de contribuição do casal. |
| 💸 | **Lançar** | Adição rápida de receitas, despesas e transferências com teclado financeiro rápido em centavos e escolha de contexto. |
| 🏦 | **Contas** | Gestão de contas bancárias (corrente, poupança, carteira ou investimentos). Podem ser marcadas como pessoais ou conjuntas. |
| 💳 | **Cartões** | Cadastro de cartões de crédito com limite, dia de fechamento e dia de vencimento. |
| 🧾 | **Faturas** | Gestão mês a mês das faturas dos cartões, compras em aberto e pagamento de fatura (debita da conta bancária sem duplicar despesa). |
| 🔄 | **Recorrentes** | Agendamento de despesas e receitas fixas (aluguel, salários, assinaturas) e visualização de parcelamentos. |
| 🏷️ | **Categorias** | Categorias e subcategorias personalizadas com cores para organizar seus gastos. |
| 🛡️ | **Backup** | Backup criptografado no Google Drive, sincronização de vencimentos no Google Agenda e status da sincronização. |

---

### 4. Regras Contábeis Automáticas

- **Compras no Cartão vs Saldo Bancário:** Compras no cartão de crédito entram na fatura do cartão e só afetam o saldo bancário no momento em que a fatura for paga (Regime de Caixa).
- **Pagamento de Fatura:** Pagar uma fatura retira dinheiro da sua conta bancária e quita a dívida do cartão, **sem** contar como uma nova despesa no mês do pagamento (evitando despesa duplicada).
- **Aporte Automático (DEC-02):** Se você paga uma despesa categorizada como **Compartilhada** utilizando uma conta **Individual**, o sistema registra a despesa para o lar e cria automaticamente um crédito de aporte a seu favor, mostrando no Dashboard quem aportou mais no mês.
- **Parcelamento Inteligente:** Em compras parceladas, o resto da divisão dos centavos é sempre alocado na primeira parcela, mantendo a precisão matemática absoluta dos centavos.

---

## 🛠️ Configuração e Execução do Projeto

### Pré-requisitos
- Node.js 20+
- Yarn 1.22+ (`npm` não é utilizado neste repositório)
- Conta no [Supabase](https://supabase.com)
- Expo CLI / EAS CLI

### 1. Clonar e Instalar Dependências
```bash
git clone <url-do-repositorio>
cd Nosotros
yarn install
```

### 2. Configurar Variáveis de Ambiente
Copie o modelo de ambiente para a raiz:
```bash
cp .env.example .env
```
Preencha o `.env` com os dados do seu projeto Supabase:
```env
EXPO_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxxxxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

### 3. Subir o Banco de Dados (Supabase)
O projeto já conta com todas as migrações SQL necessárias em `supabase/migrations/`:
```bash
# Linkar com seu projeto remoto do Supabase:
npx supabase link --project-ref <id-do-projeto>

# Aplicar as migrações na nuvem:
npx supabase db push --remote --yes
```

> **Dica no painel Supabase:** Em *Authentication* -> *Providers* -> *Email*, desmarque a opção **"Confirm email"** para testes rápidos, permitindo login logo após o cadastro sem esperar link de verificação.

---

## 🚀 Como Rodar e Compilar

### Rodar no Servidor de Desenvolvimento
```bash
yarn start -c
```
Pressione `a` para abrir no Android Emulator ou escaneie o QR Code no app Expo Go.

### Compilar o APK de Instalação Direta (Build Preview Local)
Gera o arquivo `.apk` pronto para instalar no smartphone Android diretamente pela sua máquina:
```bash
npx eas build --platform android --profile preview --local
```

### Compilar na Nuvem pelo EAS
```bash
# APK direto (Preview):
yarn build:preview

# Pacote para a Google Play Store (.aab):
yarn build:prod
```

### Testes Automatizados e Auditoria de Segurança
```bash
# Executar a suíte de testes contábeis e de segurança:
yarn test

# Auditoria de logs sensíveis em produção:
yarn security:audit
```

---

## 📄 Licença e Uso
Desenvolvido com foco em segurança estrita, privacidade financeira e respeito aos dados do casal.
