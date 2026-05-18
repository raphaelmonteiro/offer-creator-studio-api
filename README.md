# Sistema de Encartes API

API REST completa em NestJS com TypeScript para um sistema de criação de encartes/flyers de supermercado.

## 🚀 Tecnologias

- **NestJS** - Framework Node.js
- **TypeScript** - Linguagem de programação
- **TypeORM** - ORM para PostgreSQL
- **PostgreSQL** - Banco de dados
- **JWT** - Autenticação
- **Multer** - Upload de arquivos
- **Swagger/OpenAPI** - Documentação da API
- **class-validator** - Validação de dados

## 📋 Pré-requisitos

- Node.js (v18 ou superior)
- PostgreSQL (v12 ou superior)
- npm ou yarn

## 🔧 Instalação

1. Clone o repositório:

```bash
git clone <repository-url>
cd backend-new
```

2. Instale as dependências:

```bash
npm install
```

3. Configure as variáveis de ambiente:

```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas configurações:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=flyer_db

JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=3600s
JWT_REFRESH_SECRET=your-refresh-secret-key-change-in-production
JWT_REFRESH_EXPIRES_IN=7d

PORT=3000
NODE_ENV=development

UPLOAD_DEST=./uploads
MAX_FILE_SIZE=5242880

BASE_URL=http://localhost:3000
CDN_URL=http://localhost:3000/uploads
FRONTEND_URL=http://localhost:8080

# Configurações de Email (SMTP)
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=ef642424243806
SMTP_PASS=bda716512b15ae
MAIL_FROM="Encartes" <no-reply@encartes.local>

# IA / OpenAI
OPENAI_API_KEY=sk-...
OPENAI_TEXT_MODEL=gpt-4o
OPENAI_FAST_TEXT_MODEL=gpt-4o-mini
OPENAI_IMAGE_MODEL=gpt-image-1.5
OPENAI_IMAGE_FALLBACK_MODEL=gpt-image-1
OPENAI_IMAGE_PREVIEW_MODEL=gpt-image-1-mini
OPENAI_IMAGE_QUALITY=high
OPENAI_IMAGE_PREVIEW_QUALITY=medium
OPENAI_IMAGE_DEFAULT_MODE=final
OPENAI_IMAGE_BACKGROUND=opaque
OPENAI_IMAGE_OUTPUT_FORMAT=jpeg
OPENAI_IMAGE_OUTPUT_COMPRESSION=85
OPENAI_IMAGE_INPUT_FIDELITY=high
OPENAI_ENABLE_DALLE_FALLBACK=false
OPENAI_DALLE_FALLBACK_MODEL=dall-e-3
OPENAI_COST_TEXT_INPUT_1M_USD=
OPENAI_COST_TEXT_OUTPUT_1M_USD=
OPENAI_COST_IMAGE_FINAL_USD=
OPENAI_COST_IMAGE_PREVIEW_USD=
OPENAI_IMAGE_CONCURRENCY_LIMIT=2
OPENAI_IMAGE_RETRY_ATTEMPTS=2
OPENAI_IMAGE_RETRY_BASE_DELAY_MS=750
OPENAI_IMAGE_RETRY_MAX_DELAY_MS=5000
OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS=1
PIXABAY_API_KEY=your_pixabay_api_key
```

### Estrategia de modelos OpenAI

A estrategia de modelos fica documentada em [`docs/OPENAI_MODEL_STRATEGY.md`](./docs/OPENAI_MODEL_STRATEGY.md).

Resumo da decisao inicial:

- `OPENAI_TEXT_MODEL`: modelo textual principal para templates, composicao, visao e prompts.
- `OPENAI_FAST_TEXT_MODEL`: modelo textual rapido para tarefas curtas, como traducao de termos.
- `OPENAI_IMAGE_MODEL`: modelo principal de imagem, recomendado inicialmente como `gpt-image-1.5`.
- `OPENAI_IMAGE_FALLBACK_MODEL`: fallback operacional, inicialmente `gpt-image-1`.
- `OPENAI_IMAGE_PREVIEW_MODEL`: modelo para previews/baixo custo, inicialmente `gpt-image-1-mini`.
- `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_PREVIEW_QUALITY`, `OPENAI_IMAGE_DEFAULT_MODE`, `OPENAI_IMAGE_BACKGROUND`, `OPENAI_IMAGE_OUTPUT_FORMAT` e `OPENAI_IMAGE_OUTPUT_COMPRESSION`: defaults de saida usados pelo service de imagem.
- `OPENAI_IMAGE_INPUT_FIDELITY`: fidelidade usada em edicoes e geracao com referencias visuais, inicialmente `high`.
- `OPENAI_ENABLE_DALLE_FALLBACK`: deve ficar `false` por padrao; DALL-E 3 sai do caminho principal.
- `OPENAI_COST_TEXT_INPUT_1M_USD`, `OPENAI_COST_TEXT_OUTPUT_1M_USD`, `OPENAI_COST_IMAGE_FINAL_USD` e `OPENAI_COST_IMAGE_PREVIEW_USD`: opcionais para estimativa de custo nos logs estruturados.
- `OPENAI_IMAGE_CONCURRENCY_LIMIT`, `OPENAI_IMAGE_RETRY_ATTEMPTS`, `OPENAI_IMAGE_RETRY_BASE_DELAY_MS` e `OPENAI_IMAGE_RETRY_MAX_DELAY_MS`: controlam concorrencia e retry transiente das chamadas de imagem.
- `OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS`: controla quantas retentativas curtas o backend faz quando uma resposta estruturada falha no parse/schema.

4. Crie o banco de dados:

```bash
createdb flyer_db
```

5. Execute as migrações (se houver):

```bash
npm run migration:run
```

6. Inicie o servidor:

```bash
# Desenvolvimento
npm run start:dev

# Produção
npm run build
npm run start:prod
```

## 📚 Documentação da API

Após iniciar o servidor, acesse a documentação Swagger em:

- http://localhost:3000/api

## 🏗️ Estrutura do Projeto

```
src/
├── common/              # Código compartilhado
│   ├── decorators/      # Decorators customizados
│   ├── filters/         # Filtros de exceção
│   ├── guards/          # Guards de autenticação
│   ├── interceptors/     # Interceptors
│   └── utils/           # Utilitários
├── config/              # Configurações
├── modules/             # Módulos da aplicação
│   ├── auth/           # Autenticação
│   ├── products/        # Produtos
│   ├── clients/         # Clientes
│   ├── collaborators/   # Colaboradores
│   ├── flyers/          # Encartes
│   ├── templates/       # Templates
│   ├── fonts/           # Fontes
│   ├── uploads/         # Uploads
│   └── dashboard/       # Dashboard
└── main.ts             # Arquivo principal
```

## 🔐 Autenticação

A API usa JWT (JSON Web Tokens) para autenticação. Para acessar endpoints protegidos, inclua o token no header:

```
Authorization: Bearer <token>
```

## 📝 Endpoints Principais

### Autenticação

- `POST /v1/auth/login` - Login
- `POST /v1/auth/signup` - Registro
- `POST /v1/auth/refresh` - Renovar token

### Produtos

- `GET /v1/products` - Listar produtos
- `POST /v1/products` - Criar produto
- `GET /v1/products/:id` - Obter produto
- `PATCH /v1/products/:id` - Atualizar produto
- `DELETE /v1/products/:id` - Remover produto
- `POST /v1/products/:id/image` - Upload de imagem

### Clientes

- `GET /v1/clients` - Listar clientes
- `POST /v1/clients` - Criar cliente
- `GET /v1/clients/:id` - Obter cliente
- `PATCH /v1/clients/:id` - Atualizar cliente
- `DELETE /v1/clients/:id` - Remover cliente
- `POST /v1/clients/:id/logo` - Upload de logo

### Encartes

- `GET /v1/flyers` - Listar encartes
- `POST /v1/flyers` - Criar encarte
- `GET /v1/flyers/:id` - Obter encarte
- `PATCH /v1/flyers/:id` - Atualizar encarte
- `DELETE /v1/flyers/:id` - Remover encarte
- `POST /v1/flyers/:id/duplicate` - Duplicar encarte
- `POST /v1/flyers/:id/thumbnail` - Upload de thumbnail

Veja a documentação completa em `docs/API_DOCUMENTATION.md`.

## 🧪 Testes

```bash
# Testes unitários
npm run test

# Testes e2e
npm run test:e2e

# Cobertura
npm run test:cov
```

## 📦 Scripts Disponíveis

- `npm run build` - Compilar o projeto
- `npm run start` - Iniciar em modo produção
- `npm run start:dev` - Iniciar em modo desenvolvimento
- `npm run start:debug` - Iniciar em modo debug
- `npm run lint` - Executar linter
- `npm run format` - Formatar código

## 🗄️ Banco de Dados

O projeto usa TypeORM com PostgreSQL. As entidades são automaticamente sincronizadas em desenvolvimento (quando `NODE_ENV=development`).

Para produção, use migrações:

```bash
npm run migration:generate -- -n MigrationName
npm run migration:run
```

### 📖 Instalação e Configuração do PostgreSQL

Para instalar e configurar o PostgreSQL no servidor de produção, consulte o guia completo:

**[📄 Guia de Instalação do PostgreSQL](./docs/POSTGRESQL_SETUP.md)**

O guia inclui:

- Instalação em Ubuntu/Debian e CentOS/RHEL
- Criação de usuário e banco de dados
- Configuração de segurança
- Backup e restauração
- Troubleshooting comum

## 🚀 Deploy em Produção com PM2

### Pré-requisitos

- Node.js instalado no servidor
- PM2 instalado globalmente: `npm install -g pm2`
- PostgreSQL configurado
- Arquivo `.env` configurado com todas as variáveis necessárias

### Passos para Deploy

1. **No servidor, clone/atualize o repositório:**

```bash
git clone <repository-url>
cd backend-new
```

2. **Instale as dependências:**

```bash
npm install --production
```

3. **Compile o projeto:**

```bash
npm run build
```

4. **Configure o arquivo `.env` com as variáveis de ambiente:**

```env
NODE_ENV=production
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=seu_usuario
DB_PASSWORD=sua_senha
DB_DATABASE=flyer_db
JWT_SECRET=seu-jwt-secret-super-seguro
JWT_EXPIRES_IN=3600s
JWT_REFRESH_SECRET=seu-refresh-secret-super-seguro
JWT_REFRESH_EXPIRES_IN=7d
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=587
SMTP_USER=seu_usuario_smtp
SMTP_PASS=sua_senha_smtp
MAIL_FROM="Encartes" <no-reply@encartes.local>
OPENAI_API_KEY=sk-...
OPENAI_TEXT_MODEL=gpt-4o
OPENAI_FAST_TEXT_MODEL=gpt-4o-mini
OPENAI_IMAGE_MODEL=gpt-image-1.5
OPENAI_IMAGE_FALLBACK_MODEL=gpt-image-1
OPENAI_IMAGE_PREVIEW_MODEL=gpt-image-1-mini
OPENAI_IMAGE_QUALITY=high
OPENAI_IMAGE_PREVIEW_QUALITY=medium
OPENAI_IMAGE_DEFAULT_MODE=final
OPENAI_IMAGE_BACKGROUND=opaque
OPENAI_IMAGE_OUTPUT_FORMAT=jpeg
OPENAI_IMAGE_OUTPUT_COMPRESSION=85
OPENAI_IMAGE_INPUT_FIDELITY=high
OPENAI_ENABLE_DALLE_FALLBACK=false
OPENAI_DALLE_FALLBACK_MODEL=dall-e-3
OPENAI_COST_TEXT_INPUT_1M_USD=
OPENAI_COST_TEXT_OUTPUT_1M_USD=
OPENAI_COST_IMAGE_FINAL_USD=
OPENAI_COST_IMAGE_PREVIEW_USD=
OPENAI_IMAGE_CONCURRENCY_LIMIT=2
OPENAI_IMAGE_RETRY_ATTEMPTS=2
OPENAI_IMAGE_RETRY_BASE_DELAY_MS=750
OPENAI_IMAGE_RETRY_MAX_DELAY_MS=5000
OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS=1
PIXABAY_API_KEY=your_pixabay_api_key
BASE_URL=https://api.seudominio.com
FRONTEND_URL=https://seudominio.com
UPLOAD_DEST=./uploads
```

5. **Crie a pasta de logs (se não existir):**

```bash
mkdir -p logs
```

6. **Inicie a aplicação com PM2:**

```bash
pm2 start ecosystem.config.js
```

7. **Salve a configuração do PM2 para iniciar automaticamente após reinicialização:**

```bash
pm2 save
pm2 startup
```

### Comandos PM2 Úteis

```bash
# Ver status da aplicação
pm2 status

# Ver logs em tempo real
pm2 logs flyer-api

# Reiniciar a aplicação
pm2 restart flyer-api

# Parar a aplicação
pm2 stop flyer-api

# Remover a aplicação do PM2
pm2 delete flyer-api

# Ver informações detalhadas
pm2 show flyer-api

# Monitorar recursos (CPU, memória)
pm2 monit
```

### Atualizando a Aplicação

```bash
# 1. Pare a aplicação
pm2 stop flyer-api

# 2. Atualize o código (git pull, etc)
git pull origin main

# 3. Instale novas dependências (se houver)
npm install --production

# 4. Recompile
npm run build

# 5. Reinicie a aplicação
pm2 restart flyer-api
```

### Configuração da Porta

A porta é configurada via variável de ambiente `PORT` no arquivo `.env` ou no `ecosystem.config.js`. Por padrão, está configurada para **3001**.

Para alterar a porta, edite o arquivo `ecosystem.config.js` ou defina a variável `PORT` no `.env`:

```env
PORT=3001
```

## 📄 Licença

Este projeto é privado e não possui licença pública.
