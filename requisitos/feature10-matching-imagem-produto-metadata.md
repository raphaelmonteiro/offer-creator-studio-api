# Feature 10 — Melhorar matching imagem ↔ produto via metadata estruturado

## Contexto

Hoje, `POST /v1/ai/product-image-match` (em [gallery-embedding.service.ts](../src/modules/ai/gallery-embedding.service.ts) — não há `product-image-match.service.ts` separado) só compara um embedding de texto do nome do produto contra um embedding de texto derivado do **nome do arquivo + pasta** da imagem (`text-embedding-3-small` via pgvector cosine). Isso falha sempre que o nome do arquivo não descreve bem o produto (caso comum: "IMG_2401.jpg", "ruffles-final-v3.png") ou quando o nome da lista vem cru e abreviado ("papel hig stylus leve 12 pague 11 20M").

A melhoria: extrair **um schema estruturado** dos dois lados (visão LLM na imagem; parser LLM no nome da lista), guardar como JSONB em Postgres, e substituir o score atual por um **score híbrido ponderado** (identificador > marca+variante > categoria-taxonomia > similaridade textual > pack/quantidade). Quando a confiança ficar em faixa intermediária, mostrar **top-3 candidatos** no editor para o usuário escolher.

Decisões já tomadas com o usuário:
- **Async no upload** (fire-and-forget, padrão que o projeto já usa em `triggerEmbedding`) — sem introduzir Bull/BullMQ.
- **Escopo**: metadata + matching híbrido + UI de revisão de candidatos. Sem loop de aprendizado nesta iteração.
- **Taxonomia**: Google Product Taxonomy pt-BR.
- **Banco**: continua Postgres + JSONB (não migrar para Mongo).
- **Nome com "X OU Y"** (ex.: `"STEAK ... PERDIGÃO OU SADIA"`, `"PÃO DE FORMA VISCONTI 400G TRAD OU INTEGRAL"`) gera múltiplas `alternatives[]`; matching aceita imagem de qualquer alternativa e usa a melhor pontuação.
- **Limpeza de planilha não estruturada** (estilo `JORNAL_MAIO_NOVOS_PRODUTOS.xlsx`, com cabeçalhos de seção misturados a produtos e sem colunas fixas) fica **fora desta iteração** — é follow-up documentado.

## Schema do "formulário de produto" (compartilhado imagem/nome)

Um único schema TS validado por Zod, reusado pelo extrator de visão e pelo parser de nome. Campos com confiança por campo (`fieldConfidence`) para o score saber em quem confiar:

```ts
ProductMetadata {
  title: string                // nome normalizado, sem promo nem preço-cliente embutido
  category: {                  // Google Product Taxonomy
    id: number
    path: string[]             // ["Alimentos", "Salgadinhos", "Batata frita"]
  } | null
  quantity: { value: number; unit: 'g'|'kg'|'ml'|'l'|'un'|'m' } | null
  packageType: string | null   // "garrafa"|"pote"|"sachê"|"lata"|"caixa"|"fardo"|"pacote"
  pack: { count: number; promoCount?: number } | null
                               // count = unidades por embalagem;
                               // promoCount = "leve N" quando N != count
  alternatives: Array<{        // ≥1; n>1 quando o nome traz "X OU Y"
    brand: string | null       // "Perdigão", "Sadia"
    subBrand: string | null    // "Hot Dog Coreano"
    variant: string | null     // sabor/fragrância/tipo: "Tradicional", "Defumado"
  }>
  ean: string | null           // só se claramente legível (regex 8/12/13 dígitos)
  sku: string | null
  claims: string[]             // ["zero açúcar", "leve 12 pague 11", "lavagem perfeita"]
  promo: string | null         // texto bruto da promo, se houver
  dominantColors: string[]     // só na imagem
  fieldConfidence: Record<string, number>  // 0..1 por campo
  source: 'vision' | 'name-parse'
  modelVersion: string         // ex.: "vision-v1-2026-06"
  warnings: string[]           // ex.: "input category descartada (parecia nome de produto)"
}
```

Arquivo único: `backend/src/modules/ai/metadata/product-metadata.schema.ts`.

## Mudanças no backend

### 1. Schema do banco

Adicionar ao SQL bootstrap (mesmo padrão de [001_pgvector_setup.sql](../../postgres/initdb/001_pgvector_setup.sql) que já adiciona `embedding`):

- `gallery_images.metadata jsonb` — payload `ProductMetadata`.
- `gallery_images.metadata_status text` — `pending|ready|failed`.
- `gallery_images.metadata_embedding vector(1536)` — embedding do **título normalizado + marca + variante + categoria** vindo do metadata (substitui o embedding atual derivado do filename).
- Manter `embedding` atual durante a transição (fallback se metadata ainda não processado).
- Índice HNSW partial em `metadata_embedding` espelhando o existente.

`gallery_images.entity.ts` continua `synchronize: false`; só descrever os campos novos como `select: false` se precisarmos lê-los via TypeORM, ou usar raw query (padrão já usado pelo `gallery-embedding.service`).

### 2. Novo: extrator de metadata por visão

`backend/src/modules/ai/metadata/image-metadata.service.ts`:
- `extractFromImage(url): Promise<ProductMetadata>` — chama GPT-4o-mini (vision, `detail: 'low'` no primeiro pass; promove para `high` se confiança média < 0.5).
- Prompt: schema acima + instrução "retorne JSON estrito; não invente EAN/SKU; categorize escolhendo da lista de 1º+2º nível da Google Product Taxonomy pt-BR".
- Forçar JSON via `response_format: { type: 'json_object' }` + valida com Zod; em falha, registra `metadata_status='failed'` e não derruba upload.
- Reaproveita padrão de chamada de visão do [template-image-generator.service.ts](../src/modules/ai/template-image-generator.service.ts) (linhas 123-148).

### 3. Novo: parser de nome de produto

`backend/src/modules/ai/metadata/product-name-parser.service.ts`:
- `parseNames(inputs: { name: string; categoryHint?: string }[]): Promise<ProductMetadata[]>` — batch via `gpt-4o-mini`.
- Mesmo schema, mesma taxonomia. Idempotente; LRU em memória por `(name, categoryHint)` normalizado.
- **`categoryHint` é validado antes da chamada**: se a string contém número, unidade (`KG|G|ML|L|M|UN`) ou marca conhecida, é descartada (vira `warnings: ["categoryHint descartado: parecia nome de produto"]`). Isso protege contra o caso real visto nos arquivos do cliente (coluna `categoria` corrompida com `"LAGARTO KG"`, `"MINI BOLO PANFI 70G SABORES"`, etc.).
- Prompt traz **few-shot de ~12 exemplos** cobrindo o vocabulário real:
  - Abreviações: `BISC`→biscoito, `LING`→linguiça, `MAC INST`→macarrão instantâneo, `HAMB`→hambúrguer, `LIMP`→limpador, `CONG`→congelado, `DEF`→defumado, `TEMP`→temperado, `TRAD`→tradicional, `REF`→refinado, `TP`→tipo, `HIG`→higiênico, `AMAC`→amaciante, `SAB`→sabonete, `PCT`/`FD`→embalagem, `IQF`/`C/100UNI`/`PTC`.
  - **"X OU Y"** vira ≥2 entradas em `alternatives[]` (testar com `"STEAK DE FRANGO 100G PERDIGÃO OU SADIA"` → 2 marcas; `"HAMB MISTO PERDIGÃO 672G TRAD OU DEF"` → 2 variantes da mesma marca).
  - **Promo embutida**: `"LEVE 12 PAGUE 11"` vai para `claims[]` + `pack.promoCount=12`; **não confundir com `quantity`** (regra explícita no prompt: "leve N" é contagem promocional, não a métrica do produto).
  - **Preço-cliente entre parênteses** (`"AMACIANTE YPE ACONCHEGO 2L ( CLIENTE S) 8,99"`) é removido do `title` e descartado (não vira claim).
  - Quantidade composta: `"TP 1 5KG"` → tipo 1, 5kg; `"1.05KG"`, `"672G"`, `"20M"`, `"350ML LATA"` (lata vai para `packageType`).
  - Sem marca: `"BANANA NANICA KG"`, `"PÃO FRANCÊS KG"` → `alternatives: [{brand: null, variant: null}]`, categoria forte.

### 4. Trigger no upload (async, sem fila)

Em [gallery.service.ts](../src/modules/gallery/gallery.service.ts), na função que hoje chama `triggerEmbedding`:
- Marcar `metadata_status='pending'` na criação.
- Disparar **uma única** Promise async que: (a) chama `extractFromImage`, (b) salva metadata, (c) gera o embedding novo a partir do título+marca+variante+categoria e grava em `metadata_embedding`, (d) seta `metadata_status='ready'`.
- Mesmo padrão fire-and-forget já existente — não bloqueia o response do upload.

### 5. Score híbrido novo

Em `gallery-embedding.service.ts`, novos métodos `findBestImageMatchesV2` e `findImageCandidatesForProductV2` (não tocar nos antigos até o frontend migrar):

```
score = 0.40 * idMatch        // ean igual → 1; senão 0
      + 0.25 * brandMatch     // melhor casamento entre alternatives[] do produto e brand da imagem
                              // marca+variant iguais → 1; só marca → 0.6; sem marca dos dois lados → 0.3
      + 0.15 * categoryMatch  // taxonomia: nó igual=1, mesmo pai=0.6, mesmo avô=0.3
      + 0.15 * textCosine     // similaridade do metadata_embedding
      + 0.05 * packMatch      // quantidade/unidade equivalente (ignora pack.promoCount)
```

Pondera por `fieldConfidence` dos dois lados (se a marca veio com confiança 0.4, vale 0.4 do peso de marca). O `brandMatch` itera sobre `alternatives[]` e usa a melhor pontuação — necessário para casar `"PERDIGÃO OU SADIA"` contra galeria que só tem Sadia.

Faixas:
- `>= 0.75` → auto-match (retorna no campo `matches[]` como hoje)
- `0.5..0.75` → retorna em campo novo `reviewCandidates[]` com top-3
- `< 0.5` → omite

Fallback: imagem sem metadata pronta cai no caminho antigo (cosine de filename).

### 6. Taxonomia

`backend/src/modules/ai/metadata/taxonomy/google-product-taxonomy-pt-br.json` (baixada uma vez, ~6 mil entradas, ~500kb). Helper `findCategoryById`, `pathDistance(a, b)`. Carregada em memória no boot.

### 7. Rotas admin (mesmo padrão de `x-admin-token`)

- `POST /v1/ai/gallery/backfill-metadata?batchSize=N` — processa imagens com `metadata_status IS NULL OR 'pending'`.
- `GET /v1/ai/gallery/metadata-stats` — contagens por status.

### 8. Guardas de custo

- Concorrência máx. 4 chamadas visão em paralelo (semáforo simples).
- Skip se `metadata_status='ready'` (idempotente).
- Skip imagens com mesmo hash já processadas (coluna nova `content_hash` opcional — pode ficar para depois; mencionar como follow-up).

## Mudanças no frontend

### 1. Service e contrato

[aiService](../../frontend/src/services/api/aiService.ts) (ou similar): adicionar `findProductImagesV2(products)` que devolve `{ matches[], reviewCandidates: { productId, candidates: Array<{...com score}> }[] }`. Manter `findProductImages` antiga até a UI nova estar testada.

### 2. UI de revisão de candidatos

Novo `frontend/src/components/editor/ProductImageCandidatesDialog.tsx`. Disparado a partir dos 3 pontos atuais que chamam o match:
- `GuidedProductsStepV2.tsx`
- `AddProductsWizardV2.tsx`
- `ProcessingWidget.tsx`

Comportamento: ao final do match, se `reviewCandidates` não vazio, abre dialog mostrando para cada produto pendente: thumbnail do produto (nome) + grid de 3 imagens com score e razão curta ("marca diferente", "categoria igual"). Botões: escolher uma, "nenhuma serve", "ver mais".

### 3. Indicador de status no Gallery

Em [Gallery.tsx](../../frontend/src/pages/Gallery.tsx): badge discreto nas imagens com `metadata_status='pending'` ("processando…"). Refresh suave (polling leve a cada 10s enquanto houver pendentes na viewport, ou `setTimeout` único após upload).

## Verificação end-to-end

1. **Setup**: `docker compose up` (`postgres`, `backend`, `frontend`). Confirmar que migration SQL nova adicionou colunas (`\d gallery_images` no `psql`).
2. **Upload + extração**:
   - Subir 5 imagens variadas em `/gallery` (uma com EAN visível, uma de marca conhecida tipo Ruffles, uma genérica sem marca).
   - `GET /v1/ai/gallery/metadata-stats` deve ir de `pending=5` para `ready=5` em < 60s.
   - Inspecionar `SELECT id, filename, metadata->>'brand', metadata->'category' FROM gallery_images` — verificar que marca e categoria fazem sentido.
3. **Backfill**:
   - `POST /v1/ai/gallery/backfill-metadata?batchSize=20` com `x-admin-token` para reprocessar imagens antigas que não tinham metadata.
4. **Matching com nomes ruins**:
   - Criar encarte, importar Excel com nomes adversariais: `"papel hig stylus leve 12 pague 11 20M"`, `"sab siene fragancias"`, `"ruffles 70g"`.
   - Disparar match. Verificar resposta: produtos com marca clara → `matches[]`; ambíguos → `reviewCandidates[]` com 3 opções.
5. **UI**:
   - Dialog de revisão abre, mostra os 3 candidatos com score, escolher um vincula a imagem ao produto no canvas.
6. **Regressão**:
   - Para uma imagem sem metadata ainda processado (deletar metadata via SQL), confirmar que o caminho antigo de cosine de filename ainda funciona (fallback).
7. **Custo**:
   - Logs do `openai-image.service` ou novo logger devem reportar tokens/imagem; estimar custo por 100 uploads e registrar no PR.

## O que NÃO está nesta iteração (follow-ups)

- **Limpeza de planilha não estruturada por IA** (ex.: `JORNAL_MAIO_NOVOS_PRODUTOS.xlsx`): planilhas sem colunas fixas e com cabeçalhos de seção misturados a produtos continuam exigindo edição manual antes do `BulkImportDialog`. Próxima iteração: etapa de pré-import via LLM que detecta layout, separa seção de produto, extrai preço-cliente embutido (`( CLIENTE S) 8,99`) e propaga `sectionHint` para o parser como contexto forte de categoria.
- Loop de aprendizado a partir da escolha manual do usuário (re-ranking).
- Embedding visual CLIP/SigLIP (avaliar depois se score híbrido sozinho não bastar).
- Dedupe por hash de conteúdo.
- Migração dos clientes que chamam `findProductImages` antigo para o V2 (manter ambos durante 1-2 sprints).
