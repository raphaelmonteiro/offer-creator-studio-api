# Documentação da API - Sistema de Encartes

## Visão Geral

Esta documentação descreve todos os endpoints necessários para o backend do sistema de criação de encartes promocionais.

**Base URL:** `https://api.seudominio.com/v1`

**Autenticação:** Bearer Token (JWT)
```
Authorization: Bearer <token>
```

---

## 1. Autenticação

### POST /auth/login
Autentica um usuário e retorna um token JWT.

**Request:**
```json
{
  "email": "usuario@exemplo.com",
  "password": "senha123"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_123456",
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

**Response (401):**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Email ou senha inválidos"
  }
}
```

---

### POST /auth/signup
Registra um novo usuário.

**Request:**
```json
{
  "name": "João Silva",
  "email": "usuario@exemplo.com",
  "password": "senha123",
  "confirmPassword": "senha123"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_123456",
      "name": "João Silva",
      "email": "usuario@exemplo.com",
      "emailVerified": false,
      "createdAt": "2024-01-15T10:30:00Z"
    },
    "message": "Usuário criado. Verifique seu email para ativar a conta."
  }
}
```

---

### POST /auth/refresh
Renova o token de acesso.

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 3600
  }
}
```

---

### POST /auth/forgot-password
Solicita redefinição de senha.

**Request:**
```json
{
  "email": "usuario@exemplo.com"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Email de recuperação enviado"
}
```

---

### POST /auth/reset-password
Redefine a senha com token.

**Request:**
```json
{
  "token": "reset_token_123",
  "password": "novaSenha123",
  "confirmPassword": "novaSenha123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Senha alterada com sucesso"
}
```

---

## 2. Produtos (Catálogo)

### GET /products
Lista todos os produtos do catálogo.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| page | number | Página atual (default: 1) |
| limit | number | Itens por página (default: 20) |
| search | string | Busca por nome ou SKU |
| category | string | Filtra por categoria |
| minPrice | number | Preço mínimo |
| maxPrice | number | Preço máximo |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "prod_001",
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
      },
      {
        "id": "prod_002",
        "name": "Cerveja Pilsen 350ml",
        "price": 3.49,
        "originalPrice": null,
        "unit": "un",
        "imageUrl": "https://cdn.exemplo.com/produtos/cerveja.jpg",
        "category": "Bebidas",
        "sku": "BEB001",
        "observation": null,
        "active": true,
        "createdAt": "2024-01-10T08:00:00Z",
        "updatedAt": "2024-01-10T08:00:00Z"
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

---

### GET /products/:id
Retorna um produto específico.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "prod_001",
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

---

### POST /products
Cria um novo produto.

> **Nota sobre imagens:** Para enviar uma imagem, primeiro faça upload via `POST /products/:id/image` (multipart/form-data) após criar o produto, ou use `POST /uploads` com `folder: "products"` antes de criar e passe a URL retornada.

**Request:**
```json
{
  "name": "Arroz Tipo 1 5kg",
  "price": 24.90,
  "originalPrice": 29.90,
  "unit": "un",
  "imageUrl": null,
  "category": "Mercearia",
  "sku": "MERC001",
  "observation": "Pacote família"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "prod_003",
    "name": "Arroz Tipo 1 5kg",
    "price": 24.90,
    "originalPrice": 29.90,
    "unit": "un",
    "imageUrl": null,
    "category": "Mercearia",
    "sku": "MERC001",
    "observation": "Pacote família",
    "active": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### POST /products/:id/image
Upload da imagem do produto.

**Request (multipart/form-data):**
```
file: <produto.jpg>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "imageUrl": "https://cdn.exemplo.com/produtos/prod_003.jpg"
  }
}

---

### PUT /products/:id
Atualiza um produto existente.

**Request:**
```json
{
  "name": "Arroz Tipo 1 5kg",
  "price": 22.90,
  "originalPrice": 29.90,
  "unit": "un",
  "category": "Mercearia"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "prod_003",
    "name": "Arroz Tipo 1 5kg",
    "price": 22.90,
    "originalPrice": 29.90,
    "unit": "un",
    "imageUrl": "https://cdn.exemplo.com/produtos/arroz.jpg",
    "category": "Mercearia",
    "sku": "MERC001",
    "observation": "Pacote família",
    "active": true,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T12:00:00Z"
  }
}
```

---

### DELETE /products/:id
Remove um produto (soft delete).

**Response (200):**
```json
{
  "success": true,
  "message": "Produto removido com sucesso"
}
```

---

### POST /products/import
Importa produtos em lote (CSV/Excel).

**Request (multipart/form-data):**
```
file: <arquivo.csv>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "imported": 45,
    "failed": 2,
    "errors": [
      { "row": 12, "message": "SKU duplicado: CARNE001" },
      { "row": 28, "message": "Preço inválido" }
    ]
  }
}
```

---

## 3. Clientes

### GET /clients
Lista todos os clientes.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| page | number | Página atual |
| limit | number | Itens por página |
| search | string | Busca por nome ou CNPJ |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "clients": [
      {
        "id": "cli_001",
        "name": "Supermercado Bom Preço",
        "cnpj": "12.345.678/0001-90",
        "logoUrl": "https://cdn.exemplo.com/logos/bompreco.png",
        "contacts": [
          {
            "id": "cont_001",
            "name": "Maria Silva",
            "role": "Gerente de Marketing",
            "email": "maria@bompreco.com",
            "phone": "(11) 99999-9999"
          },
          {
            "id": "cont_002",
            "name": "João Santos",
            "role": "Diretor Comercial",
            "email": "joao@bompreco.com",
            "phone": "(11) 98888-8888"
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

---

### GET /clients/:id
Retorna um cliente específico.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "cli_001",
    "name": "Supermercado Bom Preço",
    "cnpj": "12.345.678/0001-90",
    "logoUrl": "https://cdn.exemplo.com/logos/bompreco.png",
    "contacts": [
      {
        "id": "cont_001",
        "name": "Maria Silva",
        "role": "Gerente de Marketing",
        "email": "maria@bompreco.com",
        "phone": "(11) 99999-9999"
      }
    ],
    "flyers": [
      {
        "id": "fly_001",
        "name": "Ofertas de Janeiro",
        "createdAt": "2024-01-15T10:00:00Z"
      }
    ],
    "createdAt": "2024-01-05T10:00:00Z",
    "updatedAt": "2024-01-10T15:30:00Z"
  }
}
```

---

### POST /clients
Cria um novo cliente.

> **Nota sobre logo:** Para enviar um logo, primeiro faça upload via `POST /clients/:id/logo` (multipart/form-data) após criar o cliente, ou use `POST /uploads` com `folder: "logos"` antes de criar e passe a URL retornada.

**Request:**
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

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "cli_002",
    "name": "Supermercado Bom Preço",
    "cnpj": "12.345.678/0001-90",
    "logoUrl": null,
    "contacts": [
      {
        "id": "cont_003",
        "name": "Maria Silva",
        "role": "Gerente de Marketing",
        "email": "maria@bompreco.com",
        "phone": "(11) 99999-9999"
      }
    ],
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### POST /clients/:id/logo
Upload do logo do cliente.

**Request (multipart/form-data):**
```
file: <logo.png>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "logoUrl": "https://cdn.exemplo.com/logos/cli_002_logo.png"
  }
}

---

### PUT /clients/:id
Atualiza um cliente.

**Request:**
```json
{
  "name": "Supermercado Bom Preço LTDA",
  "cnpj": "12.345.678/0001-90",
  "contacts": [
    {
      "id": "cont_001",
      "name": "Maria Silva",
      "role": "Diretora de Marketing",
      "email": "maria@bompreco.com",
      "phone": "(11) 99999-9999"
    },
    {
      "name": "Carlos Souza",
      "role": "Assistente",
      "email": "carlos@bompreco.com",
      "phone": "(11) 97777-7777"
    }
  ]
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "cli_001",
    "name": "Supermercado Bom Preço LTDA",
    "cnpj": "12.345.678/0001-90",
    "logoUrl": "https://cdn.exemplo.com/logos/bompreco.png",
    "contacts": [
      {
        "id": "cont_001",
        "name": "Maria Silva",
        "role": "Diretora de Marketing",
        "email": "maria@bompreco.com",
        "phone": "(11) 99999-9999"
      },
      {
        "id": "cont_004",
        "name": "Carlos Souza",
        "role": "Assistente",
        "email": "carlos@bompreco.com",
        "phone": "(11) 97777-7777"
      }
    ],
    "createdAt": "2024-01-05T10:00:00Z",
    "updatedAt": "2024-01-15T12:00:00Z"
  }
}
```

---

### DELETE /clients/:id
Remove um cliente.

**Response (200):**
```json
{
  "success": true,
  "message": "Cliente removido com sucesso"
}
```

---

### POST /clients/:id/logo
Upload do logo do cliente.

**Request (multipart/form-data):**
```
file: <logo.png>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "logoUrl": "https://cdn.exemplo.com/logos/cli_001_logo.png"
  }
}
```

---

## 4. Colaboradores

### GET /collaborators
Lista todos os colaboradores.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| page | number | Página atual |
| limit | number | Itens por página |
| search | string | Busca por nome ou email |
| role | string | Filtra por role (collaborator, manager, admin) |
| status | string | Filtra por status (active, inactive) |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "collaborators": [
      {
        "id": "col_001",
        "name": "Ana Paula",
        "email": "ana@empresa.com",
        "phone": "(11) 99999-9999",
        "role": "manager",
        "status": "active",
        "avatarUrl": "https://cdn.exemplo.com/avatars/ana.jpg",
        "createdAt": "2024-01-05T10:00:00Z",
        "updatedAt": "2024-01-10T15:30:00Z"
      },
      {
        "id": "col_002",
        "name": "Pedro Lima",
        "email": "pedro@empresa.com",
        "phone": "(11) 98888-8888",
        "role": "collaborator",
        "status": "active",
        "avatarUrl": null,
        "createdAt": "2024-01-08T14:00:00Z",
        "updatedAt": "2024-01-08T14:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 10,
      "totalPages": 1
    }
  }
}
```

---

### GET /collaborators/:id
Retorna um colaborador específico.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "col_001",
    "name": "Ana Paula",
    "email": "ana@empresa.com",
    "phone": "(11) 99999-9999",
    "role": "manager",
    "status": "active",
    "avatarUrl": "https://cdn.exemplo.com/avatars/ana.jpg",
    "permissions": [
      "flyers.create",
      "flyers.edit",
      "flyers.delete",
      "clients.view",
      "products.view"
    ],
    "createdAt": "2024-01-05T10:00:00Z",
    "updatedAt": "2024-01-10T15:30:00Z"
  }
}
```

---

### POST /collaborators
Cria um novo colaborador.

**Request:**
```json
{
  "name": "Carlos Santos",
  "email": "carlos@empresa.com",
  "phone": "(11) 97777-7777",
  "role": "collaborator",
  "password": "senha123"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "col_003",
    "name": "Carlos Santos",
    "email": "carlos@empresa.com",
    "phone": "(11) 97777-7777",
    "role": "collaborator",
    "status": "active",
    "avatarUrl": null,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### PUT /collaborators/:id
Atualiza um colaborador.

**Request:**
```json
{
  "name": "Carlos Santos Silva",
  "phone": "(11) 96666-6666",
  "role": "manager",
  "status": "active"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "col_003",
    "name": "Carlos Santos Silva",
    "email": "carlos@empresa.com",
    "phone": "(11) 96666-6666",
    "role": "manager",
    "status": "active",
    "avatarUrl": null,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T12:00:00Z"
  }
}
```

---

### DELETE /collaborators/:id
Remove um colaborador.

**Response (200):**
```json
{
  "success": true,
  "message": "Colaborador removido com sucesso"
}
```

---

### POST /collaborators/:id/avatar
Upload do avatar do colaborador.

**Request (multipart/form-data):**
```
file: <avatar.jpg>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "avatarUrl": "https://cdn.exemplo.com/avatars/col_003_avatar.jpg"
  }
}
```

---

## 5. Encartes (Flyers)

### GET /flyers
Lista todos os encartes.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| page | number | Página atual |
| limit | number | Itens por página |
| search | string | Busca por nome |
| clientId | string | Filtra por cliente |
| startDate | string | Data inicial (ISO 8601) |
| endDate | string | Data final (ISO 8601) |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "flyers": [
      {
        "id": "fly_001",
        "name": "Ofertas de Janeiro",
        "clientId": "cli_001",
        "clientName": "Supermercado Bom Preço",
        "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg",
        "status": "draft",
        "createdAt": "2024-01-15T10:00:00Z",
        "updatedAt": "2024-01-15T14:30:00Z"
      },
      {
        "id": "fly_002",
        "name": "Promoção Fim de Semana",
        "clientId": null,
        "clientName": null,
        "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_002.jpg",
        "status": "published",
        "createdAt": "2024-01-12T08:00:00Z",
        "updatedAt": "2024-01-14T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 35,
      "totalPages": 2
    }
  }
}
```

---

### GET /flyers/:id
Retorna um encarte específico com configuração completa.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "fly_001",
    "name": "Ofertas de Janeiro",
    "clientId": "cli_001",
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
        },
        {
          "id": "sec_002",
          "name": "Bebidas",
          "backgroundColor": "#DBEAFE",
          "textColor": "#1E40AF",
          "visible": true,
          "order": 1
        }
      ],
      "sectionLayout": {
        "type": "auto",
        "config": {}
      },
      "products": [
        {
          "id": "fp_001",
          "productId": "prod_001",
          "sectionId": "sec_001",
          "name": "Picanha Bovina Premium",
          "price": 69.90,
          "originalPrice": 89.90,
          "unit": "kg",
          "imageUrl": "https://cdn.exemplo.com/produtos/picanha.jpg",
          "observation": "Oferta válida até domingo",
          "position": { "x": 0, "y": 0 },
          "size": { "width": 1, "height": 1 }
        },
        {
          "id": "fp_002",
          "productId": "prod_003",
          "sectionId": "sec_002",
          "name": "Cerveja Pilsen 350ml",
          "price": 2.99,
          "originalPrice": 3.49,
          "unit": "un",
          "imageUrl": "https://cdn.exemplo.com/produtos/cerveja.jpg",
          "observation": "Leve 6 pague 5",
          "position": { "x": 0, "y": 1 },
          "size": { "width": 1, "height": 1 }
        }
      ]
    },
    "createdAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-15T14:30:00Z"
  }
}
```

---

### POST /flyers
Cria um novo encarte.

**Request:**
```json
{
  "name": "Ofertas de Janeiro",
  "clientId": "cli_001",
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

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "fly_003",
    "name": "Ofertas de Janeiro",
    "clientId": "cli_001",
    "clientName": "Supermercado Bom Preço",
    "thumbnailUrl": null,
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
        "backgroundColor": "#FFFFFF"
      },
      "sections": [],
      "sectionLayout": {
        "type": "auto",
        "config": {}
      },
      "products": []
    },
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### PUT /flyers/:id
Atualiza um encarte.

**Request:**
```json
{
  "name": "Ofertas de Janeiro - Atualizado",
  "clientId": "cli_001",
  "configuration": {
    "version": "1.0",
    "template": "modern",
    "orientation": "portrait",
    "gridLayout": "3x4",
    "settings": {
      "showOriginalPrice": true,
      "showUnit": true,
      "priceColor": "#DC2626",
      "backgroundColor": "#FFFBEB"
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
        "productId": "prod_001",
        "sectionId": "sec_001",
        "name": "Picanha Bovina Premium",
        "price": 59.90,
        "originalPrice": 89.90,
        "unit": "kg",
        "imageUrl": "https://cdn.exemplo.com/produtos/picanha.jpg",
        "observation": "Super oferta!",
        "position": { "x": 0, "y": 0 },
        "size": { "width": 1, "height": 1 }
      }
    ]
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "fly_001",
    "name": "Ofertas de Janeiro - Atualizado",
    "clientId": "cli_001",
    "clientName": "Supermercado Bom Preço",
    "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg",
    "status": "draft",
    "configuration": { ... },
    "createdAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-15T16:00:00Z"
  }
}
```

---

### DELETE /flyers/:id
Remove um encarte.

**Response (200):**
```json
{
  "success": true,
  "message": "Encarte removido com sucesso"
}
```

---

### POST /flyers/:id/duplicate
Duplica um encarte.

**Request:**
```json
{
  "name": "Ofertas de Janeiro - Cópia"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "fly_004",
    "name": "Ofertas de Janeiro - Cópia",
    "clientId": "cli_001",
    "clientName": "Supermercado Bom Preço",
    "thumbnailUrl": null,
    "status": "draft",
    "configuration": { ... },
    "createdAt": "2024-01-15T16:30:00Z",
    "updatedAt": "2024-01-15T16:30:00Z"
  }
}
```

---

### POST /flyers/:id/thumbnail
Upload/atualiza o thumbnail do encarte.

**Request (multipart/form-data):**
```
file: <thumbnail.jpg>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg"
  }
}
```

---

### GET /flyers/:id/export
Exporta o encarte em formato específico.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| format | string | Formato: pdf, png, jpg |
| quality | string | Qualidade: low, medium, high |

**Response (200):**
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

## 6. Templates

### GET /templates
Lista todos os templates.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| page | number | Página atual |
| limit | number | Itens por página |
| search | string | Busca por nome |
| type | string | Tipo: header, footer, full |
| isDefault | boolean | Apenas templates padrão |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "templates": [
      {
        "id": "tpl_001",
        "name": "Header Clássico Vermelho",
        "type": "header",
        "thumbnailUrl": "https://cdn.exemplo.com/templates/tpl_001.jpg",
        "isDefault": true,
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z"
      },
      {
        "id": "tpl_002",
        "name": "Footer com Endereço",
        "type": "footer",
        "thumbnailUrl": "https://cdn.exemplo.com/templates/tpl_002.jpg",
        "isDefault": false,
        "createdAt": "2024-01-10T10:00:00Z",
        "updatedAt": "2024-01-12T15:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 15,
      "totalPages": 1
    }
  }
}
```

---

### GET /templates/:id
Retorna um template específico com configuração.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "tpl_001",
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
        },
        {
          "id": "el_002",
          "type": "image",
          "src": "https://cdn.exemplo.com/assets/logo-placeholder.png",
          "x": 600,
          "y": 20,
          "width": 150,
          "height": 80,
          "style": {
            "objectFit": "contain"
          }
        }
      ]
    },
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

### POST /templates
Cria um novo template.

**Request:**
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
  }
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "tpl_003",
    "name": "Header Moderno Azul",
    "type": "header",
    "thumbnailUrl": null,
    "isDefault": false,
    "configuration": { ... },
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### PUT /templates/:id
Atualiza um template.

**Request:**
```json
{
  "name": "Header Moderno Azul v2",
  "configuration": {
    "width": 794,
    "height": 140,
    "backgroundColor": "#1E3A8A",
    "elements": [
      {
        "id": "el_001",
        "type": "text",
        "content": "SUPER PROMOÇÃO",
        "x": 50,
        "y": 50,
        "width": 400,
        "height": 50,
        "style": {
          "fontFamily": "Oswald",
          "fontSize": 40,
          "fontWeight": "bold",
          "color": "#FEF08A",
          "textAlign": "left"
        }
      }
    ]
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "tpl_003",
    "name": "Header Moderno Azul v2",
    "type": "header",
    "thumbnailUrl": "https://cdn.exemplo.com/templates/tpl_003.jpg",
    "isDefault": false,
    "configuration": { ... },
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T12:00:00Z"
  }
}
```

---

### DELETE /templates/:id
Remove um template (apenas templates não-padrão).

**Response (200):**
```json
{
  "success": true,
  "message": "Template removido com sucesso"
}
```

---

## 7. Fontes Personalizadas

### GET /fonts
Lista todas as fontes personalizadas.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "fonts": [
      {
        "id": "font_001",
        "family": "Bebas Neue",
        "weight": "400",
        "style": "normal",
        "fileUrl": "https://cdn.exemplo.com/fonts/bebas-neue.woff2",
        "createdAt": "2024-01-10T10:00:00Z"
      },
      {
        "id": "font_002",
        "family": "Bebas Neue",
        "weight": "700",
        "style": "normal",
        "fileUrl": "https://cdn.exemplo.com/fonts/bebas-neue-bold.woff2",
        "createdAt": "2024-01-10T10:00:00Z"
      }
    ]
  }
}
```

---

### POST /fonts
Upload de nova fonte.

**Request (multipart/form-data):**
```
file: <font.woff2>
family: "Bebas Neue"
weight: "400"
style: "normal"
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "font_003",
    "family": "Bebas Neue",
    "weight": "400",
    "style": "normal",
    "fileUrl": "https://cdn.exemplo.com/fonts/font_003.woff2",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### DELETE /fonts/:id
Remove uma fonte.

**Response (200):**
```json
{
  "success": true,
  "message": "Fonte removida com sucesso"
}
```

---

## 8. Upload de Arquivos (Genérico)

### POST /uploads
Upload genérico de arquivos (imagens, etc).

**Request (multipart/form-data):**
```
file: <imagem.jpg>
folder: "products" | "logos" | "templates" | "general"
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "upl_001",
    "filename": "imagem.jpg",
    "url": "https://cdn.exemplo.com/uploads/products/upl_001.jpg",
    "mimeType": "image/jpeg",
    "size": 125000,
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

---

## 9. Dashboard / Estatísticas

### GET /dashboard/stats
Retorna estatísticas gerais.

**Response (200):**
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

---

### GET /dashboard/recent
Retorna itens recentes para o dashboard.

**Query Parameters:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| limit | number | Quantidade de itens (default: 5) |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "recentFlyers": [
      {
        "id": "fly_001",
        "name": "Ofertas de Janeiro",
        "clientName": "Supermercado Bom Preço",
        "thumbnailUrl": "https://cdn.exemplo.com/thumbnails/fly_001.jpg",
        "updatedAt": "2024-01-15T14:30:00Z"
      }
    ],
    "recentTemplates": [
      {
        "id": "tpl_002",
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

## Códigos de Erro Padrão

| Código | Descrição |
|--------|-----------|
| 400 | Bad Request - Dados inválidos |
| 401 | Unauthorized - Token inválido ou expirado |
| 403 | Forbidden - Sem permissão |
| 404 | Not Found - Recurso não encontrado |
| 409 | Conflict - Conflito (ex: email já existe) |
| 422 | Unprocessable Entity - Validação falhou |
| 429 | Too Many Requests - Rate limit |
| 500 | Internal Server Error |

**Formato de Erro:**
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

---

## Headers Padrão

**Request:**
```
Content-Type: application/json
Authorization: Bearer <token>
Accept: application/json
```

**Response:**
```
Content-Type: application/json
X-Request-Id: <uuid>
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705329600
```
