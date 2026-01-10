# 📋 Lista Completa de Rotas da API - Para Frontend

**Base URL:** `http://localhost:3000/v1` (desenvolvimento) ou `https://api.seudominio.com/v1` (produção)

**Autenticação:** Todas as rotas (exceto as marcadas como públicas) requerem o header:
```
Authorization: Bearer <token>
```

**Formato de Resposta Padrão:**
- Sucesso: `{ success: true, data: {...}, message?: string, pagination?: {...} }`
- Erro: `{ success: false, error: { code: string, message: string, details?: [...] } }`

---

## 🔓 Rotas Públicas (Sem Autenticação)

### 1. Health Check
**GET** `/health`
- **Descrição:** Verifica o status da aplicação e conexão com banco de dados
- **Autenticação:** Não requerida
- **Response:**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2026-01-09T20:15:30.123Z",
    "uptime": 123.45,
    "database": "connected",
    "environment": "development"
  }
}
```

---

## 🔐 Autenticação

### 2. Login
**POST** `/auth/login`
- **Descrição:** Autentica um usuário e retorna token JWT
- **Autenticação:** Não requerida
- **Body:**
```json
{
  "email": "usuario@exemplo.com",
  "password": "senha123"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "name": "João Silva",
      "email": "usuario@exemplo.com",
      "emailVerified": true,
      "role": "admin",
      "createdAt": "2024-01-15T10:30:00Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 3600
  }
}
```

### 3. Registro (Signup)
**POST** `/auth/signup`
- **Descrição:** Registra um novo usuário
- **Autenticação:** Não requerida
- **Body:**
```json
{
  "name": "João Silva",
  "email": "usuario@exemplo.com",
  "password": "senha123",
  "confirmPassword": "senha123"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "name": "João Silva",
      "email": "usuario@exemplo.com",
      "emailVerified": false,
      "createdAt": "2024-01-15T10:30:00Z"
    },
    "message": "Usuário criado. Verifique seu email para ativar a conta."
  }
}
```

### 4. Refresh Token
**POST** `/auth/refresh`
- **Descrição:** Renova o token de acesso usando refresh token
- **Autenticação:** Não requerida
- **Body:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 3600
  }
}
```

### 5. Esqueci a Senha
**POST** `/auth/forgot-password`
- **Descrição:** Solicita redefinição de senha por email
- **Autenticação:** Não requerida
- **Body:**
```json
{
  "email": "usuario@exemplo.com"
}
```
- **Response (200):**
```json
{
  "success": true,
  "message": "Email de recuperação enviado"
}
```

### 6. Redefinir Senha
**POST** `/auth/reset-password`
- **Descrição:** Redefine a senha com token recebido por email
- **Autenticação:** Não requerida
- **Body:**
```json
{
  "token": "reset_token_123",
  "password": "novaSenha123",
  "confirmPassword": "novaSenha123"
}
```
- **Response (200):**
```json
{
  "success": true,
  "message": "Senha alterada com sucesso"
}
```

---

## 📦 Produtos

### 7. Listar Produtos
**GET** `/products`
- **Descrição:** Lista todos os produtos com paginação e filtros
- **Autenticação:** Requerida
- **Query Parameters:**
  - `page` (number, default: 1) - Página atual
  - `limit` (number, default: 20) - Itens por página
  - `search` (string, opcional) - Busca por nome ou SKU
  - `category` (string, opcional) - Filtra por categoria
  - `minPrice` (number, opcional) - Preço mínimo
  - `maxPrice` (number, opcional) - Preço máximo
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "uuid",
        "name": "Picanha Bovina Premium",
        "price": 69.90,
        "originalPrice": 89.90,
        "unit": "kg",
        "imageUrl": "https://cdn.exemplo.com/produtos/picanha.jpg",
        "category": "Carnes",
        "sku": "CARNE001",
        "observation": "Produto premium",
        "active": true,
        "createdAt": "2024-01-10T08:00:00Z",
        "updatedAt": "2024-01-15T14:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "totalPages": 8
    }
  }
}
```

### 8. Obter Produto
**GET** `/products/:id`
- **Descrição:** Retorna um produto específico
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Picanha Bovina Premium",
    "price": 69.90,
    "originalPrice": 89.90,
    "unit": "kg",
    "imageUrl": "https://cdn.exemplo.com/produtos/picanha.jpg",
    "category": "Carnes",
    "sku": "CARNE001",
    "observation": "Produto premium",
    "active": true,
    "createdAt": "2024-01-10T08:00:00Z",
    "updatedAt": "2024-01-15T14:30:00Z"
  }
}
```

### 9. Criar Produto
**POST** `/products`
- **Descrição:** Cria um novo produto
- **Autenticação:** Requerida
- **Body:**
```json
{
  "name": "Arroz Tipo 1 5kg",
  "price": 24.90,
  "originalPrice": 29.90,
  "unit": "un",
  "imageUrl": null,
  "category": "Mercearia",
  "sku": "MERC001",
  "observation": "Pacote família",
  "active": true
}
```
- **Response (201):** Retorna o produto criado

### 10. Atualizar Produto
**PATCH** `/products/:id`
- **Descrição:** Atualiza um produto existente
- **Autenticação:** Requerida
- **Body:** (todos os campos são opcionais)
```json
{
  "name": "Arroz Tipo 1 5kg",
  "price": 22.90,
  "originalPrice": 29.90,
  "unit": "un",
  "category": "Mercearia"
}
```
- **Response (200):** Retorna o produto atualizado

### 11. Remover Produto
**DELETE** `/products/:id`
- **Descrição:** Remove um produto (soft delete - marca como inativo)
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "message": "Produto removido com sucesso"
}
```

### 12. Upload de Imagem do Produto
**POST** `/products/:id/image`
- **Descrição:** Faz upload da imagem do produto
- **Autenticação:** Requerida
- **Content-Type:** `multipart/form-data`
- **Body:** 
  - `file` (File) - Arquivo de imagem
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "imageUrl": "https://cdn.exemplo.com/produtos/prod_003.jpg"
  }
}
```

---

## 🏢 Clientes

### 13. Listar Clientes
**GET** `/clients`
- **Descrição:** Lista todos os clientes com paginação
- **Autenticação:** Requerida
- **Query Parameters:**
  - `page` (number, default: 1)
  - `limit` (number, default: 20)
  - `search` (string, opcional) - Busca por nome ou CNPJ
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "clients": [
      {
        "id": "uuid",
        "name": "Supermercado Bom Preço",
        "cnpj": "12.345.678/0001-90",
        "logoUrl": "https://cdn.exemplo.com/logos/bompreco.png",
        "contacts": [
          {
            "id": "uuid",
            "name": "Maria Silva",
            "role": "Gerente de Marketing",
            "email": "maria@bompreco.com",
            "phone": "(11) 99999-9999"
          }
        ],
        "createdAt": "2024-01-05T10:00:00Z",
        "updatedAt": "2024-01-10T15:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 25,
      "totalPages": 2
    }
  }
}
```

### 14. Obter Cliente
**GET** `/clients/:id`
- **Descrição:** Retorna um cliente específico com contatos e encartes relacionados
- **Autenticação:** Requerida
- **Response (200):** Retorna cliente completo com contatos

### 15. Criar Cliente
**POST** `/clients`
- **Descrição:** Cria um novo cliente
- **Autenticação:** Requerida
- **Body:**
```json
{
  "name": "Supermercado Bom Preço",
  "cnpj": "12.345.678/0001-90",
  "logoUrl": null,
  "contacts": [
    {
      "name": "Maria Silva",
      "role": "Gerente de Marketing",
      "email": "maria@bompreco.com",
      "phone": "(11) 99999-9999"
    }
  ]
}
```
- **Response (201):** Retorna o cliente criado

### 16. Atualizar Cliente
**PATCH** `/clients/:id`
- **Descrição:** Atualiza um cliente existente
- **Autenticação:** Requerida
- **Body:** (todos os campos são opcionais)
```json
{
  "name": "Supermercado Bom Preço LTDA",
  "cnpj": "12.345.678/0001-90",
  "contacts": [
    {
      "id": "uuid", // Se tiver ID, atualiza; se não, cria novo
      "name": "Maria Silva",
      "role": "Diretora de Marketing",
      "email": "maria@bompreco.com",
      "phone": "(11) 99999-9999"
    },
    {
      "name": "Carlos Souza", // Sem ID = novo contato
      "role": "Assistente",
      "email": "carlos@bompreco.com",
      "phone": "(11) 97777-7777"
    }
  ]
}
```
- **Response (200):** Retorna o cliente atualizado

### 17. Remover Cliente
**DELETE** `/clients/:id`
- **Descrição:** Remove um cliente permanentemente
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "message": "Cliente removido com sucesso"
}
```

### 18. Upload de Logo do Cliente
**POST** `/clients/:id/logo`
- **Descrição:** Faz upload do logo do cliente
- **Autenticação:** Requerida
- **Content-Type:** `multipart/form-data`
- **Body:**
  - `file` (File) - Arquivo de imagem
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "logoUrl": "https://cdn.exemplo.com/logos/cli_002_logo.png"
  }
}
```

---

## 👥 Colaboradores

### 19. Listar Colaboradores
**GET** `/collaborators`
- **Descrição:** Lista todos os colaboradores com paginação
- **Autenticação:** Requerida
- **Query Parameters:**
  - `page` (number, default: 1)
  - `limit` (number, default: 20)
  - `search` (string, opcional) - Busca por nome ou email
  - `role` (string, opcional) - Filtra por role: `collaborator`, `manager`, `admin`
  - `status` (string, opcional) - Filtra por status: `active`, `inactive`
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "collaborators": [
      {
        "id": "uuid",
        "name": "Ana Paula",
        "email": "ana@empresa.com",
        "phone": "(11) 99999-9999",
        "role": "manager",
        "status": "active",
        "avatarUrl": "https://cdn.exemplo.com/avatars/ana.jpg",
        "createdAt": "2024-01-05T10:00:00Z",
        "updatedAt": "2024-01-10T15:30:00Z"
      }
    ],
    "pagination": { ... }
  }
}
```

### 20. Obter Colaborador
**GET** `/collaborators/:id`
- **Descrição:** Retorna um colaborador específico
- **Autenticação:** Requerida
- **Response (200):** Retorna colaborador completo

### 21. Criar Colaborador
**POST** `/collaborators`
- **Descrição:** Cria um novo colaborador
- **Autenticação:** Requerida
- **Body:**
```json
{
  "name": "Carlos Santos",
  "email": "carlos@empresa.com",
  "phone": "(11) 97777-7777",
  "role": "collaborator",
  "password": "senha123"
}
```
- **Response (201):** Retorna o colaborador criado

### 22. Atualizar Colaborador
**PATCH** `/collaborators/:id`
- **Descrição:** Atualiza um colaborador existente
- **Autenticação:** Requerida
- **Body:** (todos os campos são opcionais)
```json
{
  "name": "Carlos Santos Silva",
  "phone": "(11) 96666-6666",
  "role": "manager",
  "status": "active"
}
```
- **Response (200):** Retorna o colaborador atualizado

### 23. Remover Colaborador
**DELETE** `/collaborators/:id`
- **Descrição:** Remove um colaborador permanentemente
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "message": "Colaborador removido com sucesso"
}
```

### 24. Upload de Avatar do Colaborador
**POST** `/collaborators/:id/avatar`
- **Descrição:** Faz upload do avatar do colaborador
- **Autenticação:** Requerida
- **Content-Type:** `multipart/form-data`
- **Body:**
  - `file` (File) - Arquivo de imagem
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "avatarUrl": "https://cdn.exemplo.com/avatars/col_003_avatar.jpg"
  }
}
```

---

## 📄 Encartes (Flyers)

### 25. Listar Encartes
**GET** `/flyers`
- **Descrição:** Lista todos os encartes com paginação
- **Autenticação:** Requerida
- **Query Parameters:**
  - `page` (number, default: 1)
  - `limit` (number, default: 20)
  - `search` (string, opcional) - Busca por nome
  - `clientId` (string, opcional) - Filtra por cliente
  - `startDate` (string, opcional) - Data inicial (ISO 8601)
  - `endDate` (string, opcional) - Data final (ISO 8601)
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "flyers": [
      {
        "id": "uuid",
        "name": "Ofertas de Janeiro",
        "clientId": "uuid",
        "clientName": "Supermercado Bom Preço",
        "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg",
        "status": "draft",
        "createdAt": "2024-01-15T10:00:00Z",
        "updatedAt": "2024-01-15T14:30:00Z"
      }
    ],
    "pagination": { ... }
  }
}
```

### 26. Obter Encarte
**GET** `/flyers/:id`
- **Descrição:** Retorna um encarte específico com configuração completa
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Ofertas de Janeiro",
    "clientId": "uuid",
    "clientName": "Supermercado Bom Preço",
    "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg",
    "status": "draft",
    "configuration": {
      "version": "1.0",
      "template": "classic",
      "orientation": "portrait",
      "gridLayout": "3x4",
      "settings": {
        "showOriginalPrice": true,
        "showUnit": true,
        "priceColor": "#FF0000",
        "backgroundColor": "#FFFFFF",
        "headerHeight": 120,
        "footerHeight": 80
      },
      "sections": [
        {
          "id": "sec_001",
          "name": "Carnes",
          "backgroundColor": "#FEE2E2",
          "textColor": "#B91C1C",
          "visible": true,
          "order": 0
        }
      ],
      "sectionLayout": {
        "type": "auto",
        "config": {}
      },
      "products": [
        {
          "id": "fp_001",
          "productId": "uuid",
          "sectionId": "sec_001",
          "name": "Picanha Bovina Premium",
          "price": 69.90,
          "originalPrice": 89.90,
          "unit": "kg",
          "imageUrl": "https://cdn.exemplo.com/produtos/picanha.jpg",
          "observation": "Oferta válida até domingo",
          "position": { "x": 0, "y": 0 },
          "size": { "width": 1, "height": 1 }
        }
      ]
    },
    "createdAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-15T14:30:00Z"
  }
}
```

### 27. Criar Encarte
**POST** `/flyers`
- **Descrição:** Cria um novo encarte
- **Autenticação:** Requerida
- **Body:**
```json
{
  "name": "Ofertas de Janeiro",
  "clientId": "uuid",
  "configuration": {
    "version": "1.0",
    "template": "classic",
    "orientation": "portrait",
    "gridLayout": "3x4",
    "settings": {
      "showOriginalPrice": true,
      "showUnit": true,
      "priceColor": "#FF0000",
      "backgroundColor": "#FFFFFF"
    },
    "sections": [],
    "sectionLayout": {
      "type": "auto",
      "config": {}
    },
    "products": []
  }
}
```
- **Response (201):** Retorna o encarte criado

### 28. Atualizar Encarte
**PATCH** `/flyers/:id`
- **Descrição:** Atualiza um encarte existente (incluindo configuração completa)
- **Autenticação:** Requerida
- **Body:** (todos os campos são opcionais)
```json
{
  "name": "Ofertas de Janeiro - Atualizado",
  "clientId": "uuid",
  "configuration": {
    "version": "1.0",
    "template": "modern",
    "orientation": "portrait",
    "gridLayout": "3x4",
    "settings": { ... },
    "sections": [ ... ],
    "sectionLayout": { ... },
    "products": [ ... ]
  }
}
```
- **Response (200):** Retorna o encarte atualizado

### 29. Remover Encarte
**DELETE** `/flyers/:id`
- **Descrição:** Remove um encarte permanentemente
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "message": "Encarte removido com sucesso"
}
```

### 30. Duplicar Encarte
**POST** `/flyers/:id/duplicate`
- **Descrição:** Duplica um encarte existente
- **Autenticação:** Requerida
- **Body:**
```json
{
  "name": "Ofertas de Janeiro - Cópia"
}
```
- **Response (201):** Retorna o novo encarte duplicado

### 31. Upload de Thumbnail do Encarte
**POST** `/flyers/:id/thumbnail`
- **Descrição:** Faz upload do thumbnail do encarte
- **Autenticação:** Requerida
- **Content-Type:** `multipart/form-data`
- **Body:**
  - `file` (File) - Arquivo de imagem
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg"
  }
}
```

### 32. Exportar Encarte
**GET** `/flyers/:id/export`
- **Descrição:** Exporta o encarte em formato específico (PDF, PNG, JPG)
- **Autenticação:** Requerida
- **Query Parameters:**
  - `format` (string, default: "pdf") - Formato: `pdf`, `png`, `jpg`
  - `quality` (string, default: "high") - Qualidade: `low`, `medium`, `high`
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "downloadUrl": "https://cdn.exemplo.com/exports/fly_001_20240115.pdf",
    "expiresAt": "2024-01-15T18:00:00Z"
  }
}
```

---

## 🎨 Templates

### 33. Listar Templates
**GET** `/templates`
- **Descrição:** Lista todos os templates com paginação
- **Autenticação:** Requerida
- **Query Parameters:**
  - `page` (number, default: 1)
  - `limit` (number, default: 20)
  - `search` (string, opcional) - Busca por nome
  - `type` (string, opcional) - Filtra por tipo: `header`, `footer`, `full`
  - `isDefault` (boolean, opcional) - Apenas templates padrão
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "templates": [
      {
        "id": "uuid",
        "name": "Header Clássico Vermelho",
        "type": "header",
        "thumbnailUrl": "https://cdn.exemplo.com/templates/tpl_001.jpg",
        "isDefault": true,
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z"
      }
    ],
    "pagination": { ... }
  }
}
```

### 34. Obter Template
**GET** `/templates/:id`
- **Descrição:** Retorna um template específico com configuração completa
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Header Clássico Vermelho",
    "type": "header",
    "thumbnailUrl": "https://cdn.exemplo.com/templates/tpl_001.jpg",
    "isDefault": true,
    "configuration": {
      "width": 794,
      "height": 120,
      "backgroundColor": "#DC2626",
      "elements": [
        {
          "id": "el_001",
          "type": "text",
          "content": "OFERTAS DA SEMANA",
          "x": 50,
          "y": 40,
          "width": 400,
          "height": 50,
          "style": {
            "fontFamily": "Oswald",
            "fontSize": 36,
            "fontWeight": "bold",
            "color": "#FFFFFF",
            "textAlign": "left"
          }
        }
      ]
    },
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

### 35. Criar Template
**POST** `/templates`
- **Descrição:** Cria um novo template
- **Autenticação:** Requerida
- **Body:**
```json
{
  "name": "Header Moderno Azul",
  "type": "header",
  "configuration": {
    "width": 794,
    "height": 120,
    "backgroundColor": "#1E40AF",
    "elements": [
      {
        "type": "text",
        "content": "PROMOÇÃO ESPECIAL",
        "x": 50,
        "y": 40,
        "width": 400,
        "height": 50,
        "style": {
          "fontFamily": "Oswald",
          "fontSize": 36,
          "fontWeight": "bold",
          "color": "#FFFFFF",
          "textAlign": "left"
        }
      }
    ]
  },
  "isDefault": false
}
```
- **Response (201):** Retorna o template criado

### 36. Atualizar Template
**PATCH** `/templates/:id`
- **Descrição:** Atualiza um template existente
- **Autenticação:** Requerida
- **Body:** (todos os campos são opcionais)
```json
{
  "name": "Header Moderno Azul v2",
  "configuration": {
    "width": 794,
    "height": 140,
    "backgroundColor": "#1E3A8A",
    "elements": [ ... ]
  }
}
```
- **Response (200):** Retorna o template atualizado

### 37. Remover Template
**DELETE** `/templates/:id`
- **Descrição:** Remove um template (apenas templates não-padrão)
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "message": "Template removido com sucesso"
}
```

---

## 🔤 Fontes

### 38. Listar Fontes
**GET** `/fonts`
- **Descrição:** Lista todas as fontes personalizadas
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "fonts": [
      {
        "id": "uuid",
        "family": "Bebas Neue",
        "weight": "400",
        "style": "normal",
        "fileUrl": "https://cdn.exemplo.com/fonts/bebas-neue.woff2",
        "createdAt": "2024-01-10T10:00:00Z"
      }
    ]
  }
}
```

### 39. Upload de Fonte
**POST** `/fonts`
- **Descrição:** Faz upload de uma nova fonte (.ttf, .otf, .woff, .woff2)
- **Autenticação:** Requerida
- **Content-Type:** `multipart/form-data`
- **Body:**
  - `file` (File) - Arquivo de fonte
  - `family` (string) - Nome da família da fonte (ex: "Bebas Neue")
  - `weight` (string) - Peso da fonte (ex: "400", "700")
  - `style` (string) - Estilo da fonte (ex: "normal", "italic")
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "family": "Bebas Neue",
    "weight": "400",
    "style": "normal",
    "fileUrl": "https://cdn.exemplo.com/fonts/font_003.woff2",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

### 40. Remover Fonte
**DELETE** `/fonts/:id`
- **Descrição:** Remove uma fonte
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "message": "Fonte removida com sucesso"
}
```

---

## 📤 Uploads Genéricos

### 41. Upload Genérico
**POST** `/uploads`
- **Descrição:** Upload genérico de arquivos (imagens, etc)
- **Autenticação:** Requerida
- **Content-Type:** `multipart/form-data`
- **Body:**
  - `file` (File) - Arquivo a ser enviado
  - `folder` (string, opcional, default: "general") - Pasta de destino: `products`, `logos`, `templates`, `general`, `fonts`, `avatars`, `thumbnails`
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "filename": "imagem.jpg",
    "url": "https://cdn.exemplo.com/uploads/products/upl_001.jpg",
    "mimeType": "image/jpeg",
    "size": 125000,
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

---

## 📊 Dashboard

### 42. Estatísticas Gerais
**GET** `/dashboard/stats`
- **Descrição:** Retorna estatísticas gerais do sistema
- **Autenticação:** Requerida
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "totalFlyers": 35,
    "totalClients": 12,
    "totalProducts": 150,
    "totalTemplates": 8,
    "recentFlyers": 5,
    "flyersThisMonth": 12
  }
}
```

### 43. Itens Recentes
**GET** `/dashboard/recent`
- **Descrição:** Retorna itens recentes para o dashboard
- **Autenticação:** Requerida
- **Query Parameters:**
  - `limit` (number, default: 5) - Quantidade de itens
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "recentFlyers": [
      {
        "id": "uuid",
        "name": "Ofertas de Janeiro",
        "clientName": "Supermercado Bom Preço",
        "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg",
        "updatedAt": "2024-01-15T14:30:00Z"
      }
    ],
    "recentTemplates": [
      {
        "id": "uuid",
        "name": "Footer com Endereço",
        "type": "footer",
        "thumbnailUrl": "https://cdn.exemplo.com/templates/tpl_002.jpg",
        "updatedAt": "2024-01-12T15:00:00Z"
      }
    ]
  }
}
```

---

## 📝 Notas Importantes

### Códigos de Status HTTP
- `200` - Sucesso
- `201` - Criado com sucesso
- `400` - Bad Request - Dados inválidos
- `401` - Unauthorized - Token inválido ou expirado
- `403` - Forbidden - Sem permissão
- `404` - Not Found - Recurso não encontrado
- `409` - Conflict - Conflito (ex: email já existe)
- `422` - Unprocessable Entity - Validação falhou
- `500` - Internal Server Error

### Formato de Erro
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Dados inválidos",
    "details": [
      { "field": "email", "message": "Email inválido" },
      { "field": "price", "message": "Preço deve ser maior que zero" }
    ]
  }
}
```

### Headers Necessários
```
Content-Type: application/json
Authorization: Bearer <token>
Accept: application/json
```

### Upload de Arquivos
Para rotas de upload, use `multipart/form-data`:
- Campo `file` para o arquivo
- Outros campos como strings normais no form-data

---

**Total de Rotas:** 43 endpoints

**Última atualização:** Janeiro 2026
