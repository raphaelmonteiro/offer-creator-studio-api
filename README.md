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
```

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

## 📄 Licença

Este projeto é privado e não possui licença pública.
