# Feature 2 — Busca Automática de Imagens de Produtos

## Visão Geral

Integração com a API do Pixabay para sugerir imagens reais de produtos que estejam sem imagem associada no encarte aberto. O usuário aciona a busca por produto individualmente, visualiza 3 opções e seleciona a de sua preferência. A imagem selecionada é baixada pelo backend e armazenada no bucket próprio da plataforma.

A IA não está envolvida nesta feature — a busca é feita por normalização de texto e consulta direta à API do Pixabay.

---

## Regras de Negócio

- A busca é disponível apenas para produtos **sem imagem** (`imageUrl` nulo ou vazio) no encarte aberto.
- O gatilho é **manual** — um botão/ícone no card do produto no canvas do editor.
- São exibidas **3 opções de imagem** por produto.
- O usuário seleciona uma imagem no modal e pode opcionalmente marcar o checkbox **"Salvar também no catálogo de produtos"**.
- Ao confirmar:
  - A imagem é **baixada pelo backend** a partir da URL do Pixabay.
  - A imagem é salva no bucket via `UploadsService` na pasta `products/`.
  - A URL CDN retornada é aplicada ao produto no `editorStore` (persiste no encarte na próxima vez que o usuário salvar).
  - Se o checkbox estiver marcado, o frontend também atualiza o produto no catálogo via `PATCH /v1/products/:id`.
- A imagem é sempre salva no bucket — nunca referenciada diretamente pela URL do Pixabay.
- Produtos com imagem já definida **não exibem** o botão de busca.
- A busca usa o **nome do produto normalizado** como termo — a normalização é feita no backend.

---

## Normalização do Termo de Busca

O backend recebe o nome completo do produto e aplica as seguintes transformações antes de chamar a API do Pixabay:

1. Converter para minúsculas.
2. Remover números (ex: `5`, `1`, `200`).
3. Remover unidades de medida: `kg`, `g`, `mg`, `ml`, `l`, `lt`, `un`, `pct`, `cx`, `cx.`, `unid`, `unidade`, `pack`, `fardo`.
4. Remover termos genéricos de tipo: `tipo 1`, `tipo 2`, `especial`, `premium`, `tradicional`.
5. Remover caracteres especiais e espaços extras.
6. Manter no máximo 3 palavras no termo final (as mais relevantes).

**Exemplos:**

| Nome do produto | Termo de busca |
|-----------------|----------------|
| Arroz Tipo 1 Camil 5kg | arroz camil |
| Leite Integral Parmalat 1L | leite parmalat |
| Feijão Preto Kicaldo 1kg | feijão kicaldo |
| Óleo de Soja Liza 900ml | óleo soja liza |
| Refrigerante Coca-Cola 2L | refrigerante coca-cola |

---

## Arquitetura Técnica

### Módulo Backend

A feature é adicionada ao módulo `ai` criado na Feature 1:

```
src/modules/ai/
├── ai.module.ts
├── ai.controller.ts
├── ai.service.ts
└── dto/
    ├── spell-check-request.dto.ts       # Feature 1
    ├── spell-check-response.dto.ts      # Feature 1
    ├── image-search-request.dto.ts      # Feature 2
    ├── image-search-response.dto.ts     # Feature 2
    └── image-download-request.dto.ts   # Feature 2
```

### Variável de Ambiente

Adicionar ao `.env` e `.env.example`:

```
PIXABAY_API_KEY=your_pixabay_api_key
```

Obter em: https://pixabay.com/api/docs/

---

## Endpoints

### 1. Buscar imagens para um produto

```
GET /v1/ai/image-search?query=arroz+camil&rawName=Arroz+Tipo+1+Camil+5kg
Authorization: Bearer <token>
```

- `rawName`: nome original do produto (o backend normaliza)
- `query` é opcional — se não enviado, o backend usa apenas `rawName` para normalizar

**Response (sucesso):**

```json
{
  "success": true,
  "data": {
    "searchTerm": "arroz camil",
    "images": [
      {
        "pixabayId": 1234567,
        "thumbnailUrl": "https://i.pixabay.com/photo/...._150.jpg",
        "previewUrl": "https://i.pixabay.com/photo/...._640.jpg",
        "fullUrl": "https://pixabay.com/get/....",
        "width": 640,
        "height": 480
      },
      { ... },
      { ... }
    ]
  }
}
```

- `thumbnailUrl`: imagem pequena para exibição no modal (thumbnail 150px do Pixabay)
- `previewUrl`: imagem em resolução média para preview no modal (640px)
- `fullUrl`: URL de download da imagem em resolução completa — usada no endpoint de download

**Response (nenhuma imagem encontrada):**

```json
{
  "success": true,
  "data": {
    "searchTerm": "arroz camil",
    "images": []
  }
}
```

**Response (erro):**

```json
{
  "success": false,
  "error": {
    "code": "IMAGE_SEARCH_ERROR",
    "message": "Não foi possível buscar imagens. Tente novamente."
  }
}
```

---

### 2. Baixar e salvar imagem selecionada

```
POST /v1/ai/image-download
Authorization: Bearer <token>
Content-Type: application/json
```

**Request body:**

```json
{
  "imageUrl": "https://pixabay.com/get/g4e..._1280.jpg",
  "productName": "Arroz Tipo 1 Camil 5kg"
}
```

- `imageUrl`: URL da imagem selecionada no Pixabay (`fullUrl` retornado na busca)
- `productName`: usado para gerar um nome de arquivo descritivo (slugificado)

**Response (sucesso):**

```json
{
  "success": true,
  "data": {
    "imageUrl": "https://cdn.seudominio.com/uploads/products/arroz-camil-1718123456789.jpg"
  }
}
```

**Response (erro):**

```json
{
  "success": false,
  "error": {
    "code": "IMAGE_DOWNLOAD_ERROR",
    "message": "Não foi possível salvar a imagem. Tente novamente."
  }
}
```

---

## Lógica do Service

### `AiService.searchImages(rawName: string)`

1. Aplicar normalização de texto ao `rawName` (ver seção de normalização acima).
2. Chamar `GET https://pixabay.com/api/?key=...&q=<termo>&image_type=photo&per_page=3&lang=pt`.
3. Mapear os 3 primeiros resultados para o formato de resposta (`thumbnailUrl`, `previewUrl`, `fullUrl`).
4. Retornar `{ searchTerm, images[] }`.

Parâmetros relevantes da chamada ao Pixabay:
- `image_type=photo` — apenas fotos reais, sem ilustrações
- `per_page=3` — retornar exatamente 3 resultados
- `lang=pt` — preferência por imagens com tags em português
- `safesearch=true` — filtro de conteúdo seguro

### `AiService.downloadAndSaveImage(imageUrl: string, productName: string)`

1. Fazer download da imagem via `fetch` (ou `axios`) a partir da `imageUrl`.
2. Converter o stream para `Buffer`.
3. Gerar nome de arquivo: `slugify(productName) + '-' + Date.now() + extensão` (detectar extensão pelo Content-Type ou pela URL).
4. Salvar via `UploadsService.saveFile()` na pasta `products/`.
5. Retornar a URL CDN gerada.

---

## DTOs

### `ImageSearchRequestDto`

```typescript
class ImageSearchRequestDto {
  @IsString()
  @IsNotEmpty()
  rawName: string;
}
```

### `ImageSearchResponseDto`

```typescript
class PixabayImageDto {
  pixabayId: number;
  thumbnailUrl: string;
  previewUrl: string;
  fullUrl: string;
  width: number;
  height: number;
}

class ImageSearchResponseDto {
  searchTerm: string;
  images: PixabayImageDto[];
}
```

### `ImageDownloadRequestDto`

```typescript
class ImageDownloadRequestDto {
  @IsString()
  @IsUrl()
  imageUrl: string;

  @IsString()
  @IsNotEmpty()
  productName: string;
}
```

---

## Implementação Frontend

### Onde fica o botão

No componente `ProductCard.tsx`. Quando `product.imageUrl` é nulo ou vazio, exibir um botão/ícone sobreposto à área de imagem — ex: ícone de câmera ou lupa com tooltip "Buscar imagem".

### Fluxo de interação

1. Usuário clica no ícone "Buscar imagem" no card do produto.
2. Frontend exibe loading no card.
3. Chama `GET /v1/ai/image-search?rawName=<nome do produto>`.
4. Ao receber resposta:
   - Se `images` vazio → toast: "Nenhuma imagem encontrada para este produto. Tente renomear o produto."
   - Se há imagens → abre modal de seleção.
5. **Modal de seleção:**
   - Título: "Selecionar imagem para [nome do produto]"
   - Exibe 3 opções lado a lado (grid 3 colunas) com a `previewUrl`
   - Ao clicar em uma imagem, ela fica destacada (selecionada)
   - Checkbox: "Salvar também no catálogo de produtos"
   - Botão "Confirmar" (desabilitado até selecionar uma imagem) e "Cancelar"
6. Ao clicar "Confirmar":
   - Exibe loading no botão.
   - Chama `POST /v1/ai/image-download` com a `fullUrl` da imagem selecionada e o nome do produto.
   - Ao receber a URL CDN:
     - Chama `editorStore.updateProduct(productId, { imageUrl: cdnUrl })`.
     - Se checkbox marcado: chama `PATCH /v1/products/:id` com `{ imageUrl: cdnUrl }`.
     - Fecha o modal.
     - Toast de sucesso: "Imagem aplicada com sucesso."
7. Ao clicar "Cancelar": fecha o modal sem alterações.

### Tratamento de erro no frontend

- Erro na busca → toast: "Não foi possível buscar imagens. Tente novamente."
- Erro no download → toast: "Não foi possível salvar a imagem. Tente novamente."
- Timeout (> 15s) → toast de erro genérico.

---

## Dependências

### Backend

- Nenhum pacote novo necessário — `fetch` nativo do Node 18+ ou `axios` (já utilizado via `httpClient`) para download.
- Variável de ambiente `PIXABAY_API_KEY`.

### Frontend

- Nenhuma dependência nova.

---

## Casos de Borda

| Situação | Comportamento esperado |
|----------|----------------------|
| Produto já tem imagem | Botão de busca não é exibido |
| Pixabay não retorna resultados | Modal não abre; toast "Nenhuma imagem encontrada" |
| Termo normalizado fica vazio após limpeza | Usar o nome original truncado em 30 caracteres como fallback |
| Erro de download (imagem removida do Pixabay) | Toast de erro; usuário pode tentar outra opção |
| `PIXABAY_API_KEY` não configurada | Retorna `IMAGE_SEARCH_ERROR` com log no servidor |
| Usuário seleciona imagem mas fecha sem salvar | Nenhuma alteração — modal descartado |
| Checkbox "Salvar no catálogo" marcado mas produto não existe mais no catálogo | PATCH falha silenciosamente; imagem ainda é salva no encarte |
| Imagem do Pixabay muito grande (> 10MB) | Backend limita o download e retorna `IMAGE_DOWNLOAD_ERROR` |
| Mesmo produto sem imagem em dois cards (spread) | Cada card tem seu próprio botão; ao aplicar em um, o outro continua exibindo o botão até ser atualizado |

---

## Nota sobre Licença do Pixabay

As imagens do Pixabay são disponibilizadas sob a **Pixabay License**, que permite uso comercial livre sem necessidade de atribuição ao autor. Isso as torna adequadas para uso em encartes e materiais promocionais impressos ou digitais.

Referência: https://pixabay.com/service/license-summary/
