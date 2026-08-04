# Feature 12 — Imagens preferidas por cliente (vínculo real)

**Tipo:** documento técnico (tech spec)
**Público:** desenvolvimento
**Status:** implementado (Opção A — tabela N:N)
**One-pager relacionado:** [onepager-encarte-base-e-imagens-por-cliente.md](onepager-encarte-base-e-imagens-por-cliente.md)

> **Implementação (backend + frontend):**
> - Schema `client_preferred_images` no bootstrap SQL idempotente
>   ([sql/001_pgvector_setup.sql](../src/modules/gallery/sql/001_pgvector_setup.sql)).
> - Boost por cliente em `searchByEmbedding` (V1) e `searchByMetadataEmbedding` (V2), via
>   `querySimilarImages` em [gallery-embedding.service.ts](../src/modules/ai/gallery-embedding.service.ts);
>   V2 ganha bump explícito de score + reason "preferida do cliente".
> - `clientId` propagado nos 4 endpoints de match e nos DTOs; flag `isClientPreferred` no retorno.
> - Gestão do vínculo: `ClientPreferredImagesService` (gallery module).
> - Frontend: `aiService` aceita `clientId`; callers do flyer-builder-v2 passam `clientId` do store.
> - Badge "preferida do cliente" na revisão de imagens (`ProductImageMatchModalV2`).
> - Env: `AI_CLIENT_IMAGE_PREF_BOOST` (default 0.15).
>
> **Nota:** a UI de gestão do vínculo é a marcação na galeria
> ([feature13](feature13-marcacao-de-clientes-na-galeria.md)). Um diálogo "Imagens preferidas"
> na página de Clientes chegou a existir e foi **removido** — a galeria com filtro por cliente
> cobre o caso melhor (marcação em lote, imagem compartilhada entre clientes) e manter dois
> caminhos para a mesma coisa confundia. Junto dele saíram o controller
> `/clients/:id/preferred-images` e o service equivalente no frontend.

---

## 1. Contexto e objetivo

O mesmo produto tem várias fotos na galeria (ex.: várias de contrafilé). Cada cliente prefere
uma. Hoje o matching de imagem busca no **banco inteiro** e às vezes traz a foto errada,
exigindo troca manual.

**Objetivo:** vincular fotos a um cliente e, na busca por imagem, **priorizar as fotos daquele
cliente**. Com o universo reduzido às fotos certas, o acerto sobe. Se o cliente não tiver foto
de um produto, o sistema continua achando no banco geral (não fica sem imagem).

**Decisão de produto:** vínculo **real por ID** (não por nome de pasta digitado à mão, que é
onde nasce o erro).

## 2. Como o matching funciona hoje

Motor em [gallery-embedding.service.ts](../src/modules/ai/gallery-embedding.service.ts):

- `buildProductQueryText()` monta o texto do produto → embedding (`text-embedding-3-small`).
- `searchByEmbedding()` (linha ~466) roda pgvector contra **todas** as imagens:
  `WHERE gi.embedding IS NOT NULL ORDER BY gi.embedding <=> $1 LIMIT $2`.
- `findBestImageMatches()` pega o top-1 e aplica `matchThreshold`.
- `findImageCandidatesForProduct()` devolve top-N.
- Existe uma V2 híbrida (metadata + embedding) em
  [metadata/product-image-match-v2.service.ts](../src/modules/ai/metadata/product-image-match-v2.service.ts)
  com `searchByMetadataEmbedding()` e reranking por score. **Ambas** (V1 e V2) precisam
  receber o mesmo tratamento de prioridade por cliente.

A tabela `gallery_images` é `{ synchronize: false }` (gerenciada por SQL). `gallery_folders`
tem só `id`, `name`, `color` — **nenhum vínculo com cliente hoje**.

## 3. Modelo de dados — o vínculo

Duas opções. Recomendação: **Opção A** (mais flexível e cobre "mesma foto preferida por dois
clientes"). A Opção B é o mínimo viável se o mental model de "pasta do cliente" bastar.

### Opção A (recomendada) — tabela de associação N:N

Uma foto pode ser preferida por vários clientes; um cliente tem várias fotos preferidas.

```sql
CREATE TABLE client_preferred_images (
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  image_id    uuid NOT NULL REFERENCES gallery_images(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, image_id)
);
CREATE INDEX idx_cpi_client ON client_preferred_images(client_id);
CREATE INDEX idx_cpi_image  ON client_preferred_images(image_id);
```

- Não duplica arquivos: aponta para imagens existentes na galeria.
- Trocar a preferida = inserir a nova associação (e opcionalmente remover a antiga).

### Opção B — `clientId` na pasta

```sql
ALTER TABLE gallery_folders ADD COLUMN client_id uuid NULL REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX idx_gallery_folders_client ON gallery_folders(client_id);
```

- Casa com o mental model "subpasta do cliente".
- Limitação: a mesma foto física preferida por dois clientes exigiria estar em duas pastas
  (duplicar registro/arquivo). Por isso A é preferível.

> **Importante (produção):** `NODE_ENV=production` roda com `synchronize: false`. O schema é
> aplicado por **SQL/migration manual** — adicionar em `postgres/initdb/init.sql` e/ou uma
> migration versionada, e rodar na VM. Não confiar em auto-sync.

## 4. Lógica de priorização no matching

Regra de produto: **priorizar** (boost), não **filtrar rigidamente**. Assim, produto novo sem
foto do cliente ainda encontra imagem no banco geral.

### 4.1 Assinatura — passar o cliente

Adicionar `clientId?: string` opcional nos DTOs e métodos:

- `ProductImageMatchRequestDto` → campo `clientId?`
- `ProductImageCandidatesRequestDto` → campo `clientId?`
- `findBestImageMatches(products, clientId?)`
- `findImageCandidatesForProduct({ ..., clientId? })`
- V2: `findMatches(..., clientId?)` / `findCandidates(product, limit, clientId?)`

Origem do valor: o encarte em edição já tem `clientId` (entidade `flyers`). O frontend passa
esse `clientId` nas chamadas de match/candidates.

### 4.2 SQL com boost por cliente

> **Implementado com DUAS queries, não com boost no `ORDER BY`.** O esboço abaixo
> (uma query com `LEFT JOIN` e `ORDER BY distância − boost`) foi a primeira versão e
> **funciona, mas não é indexável**: o índice HNSW só atende `ORDER BY coluna <=> vetor`.
> Medido com `EXPLAIN`, essa forma caía em varredura completa — e como o matching roda
> uma vez por produto, o custo multiplicava pelo tamanho do encarte (produção tem ~13k imagens).
>
> A versão final roda duas buscas indexáveis em paralelo e combina em memória:
> 1. **top-N global** — `ORDER BY coluna <=> vetor` (usa o índice HNSW);
> 2. **preferidas do cliente** — filtra por `cpi.client_id` (índice btree, conjunto pequeno).
>
> O merge deduplica (preferida tem precedência), aplica `distância − boost` e corta no limite,
> reproduzindo exatamente o ranking pretendido. Coberto por
> [gallery-embedding.preference-search.spec.ts](../src/modules/ai/gallery-embedding.preference-search.spec.ts).

Amplia-se `searchByEmbedding` / `searchByMetadataEmbedding` para aceitar `clientId` e aplicar
um bônus de proximidade às imagens do cliente. Exemplo com Opção A:

```sql
SELECT gi.id, gi.filename, gi.url, gi."thumbnailUrl", gi."folderId",
       gf.name AS "folderName",
       (gi.embedding <=> $1::vector) AS distance,
       (cpi.client_id IS NOT NULL) AS is_client_pref
  FROM gallery_images gi
  LEFT JOIN gallery_folders gf ON gf.id = gi."folderId"
  LEFT JOIN client_preferred_images cpi
         ON cpi.image_id = gi.id AND cpi.client_id = $3
 WHERE gi.embedding IS NOT NULL
 ORDER BY (gi.embedding <=> $1::vector) - CASE WHEN cpi.client_id IS NOT NULL THEN $4 ELSE 0 END
 LIMIT $2
```

- `$3` = `clientId` (quando null, o `LEFT JOIN` não marca nada → comportamento atual).
- `$4` = `PREFERENCE_BOOST` (ex.: `0.15`), configurável via env
  (`AI_CLIENT_IMAGE_PREF_BOOST`). Distância menor = melhor, então subtraímos o bônus.
- Para Opção B, trocar o join por `gi."folderId" IN (folders do cliente)`.

### 4.2.1 Preferência decide antes do score (V2)

No matcher V2 há um passo **antes** da decisão por score: se alguma candidata plausível é foto
marcada para o cliente, ela é escolhida direto e o produto **não vai para a tela de revisão** —
é a foto que o cliente já disse que quer, não faz sentido perguntar.

```
1. existe candidata preferida com score >= PREFERENCE_AUTO_MIN?  → usa ela (sem revisão)
2. senão, melhor score >= AUTO_MATCH_THRESHOLD (0.75)?            → auto-match
3. senão, melhor score >= REVIEW_MIN_THRESHOLD (0.5)?             → revisão humana
4. senão                                                          → sem imagem
```

`PREFERENCE_AUTO_MIN` = `REVIEW_MIN_THRESHOLD` (0.5). O piso existe porque o pool de candidatas
é o top-N por similaridade e pode conter fotos marcadas para o cliente que nada têm a ver com o
produto sendo casado — sem ele, um contrafilé poderia receber a foto preferida de um refrigerante.

Coberto por [product-image-match-v2.preference.spec.ts](../src/modules/ai/metadata/product-image-match-v2.preference.spec.ts).

### 4.3 Efeito esperado

- Foto do cliente com boa similaridade → sobe pro top-1 (resolve o "acerta mais").
- Sem foto do cliente → ranking normal do banco geral (resolve "produto novo").
- No `findImageCandidatesForProduct` (as 3 primeiras que ele mencionou), as preferidas do
  cliente aparecem no topo.

## 5. Gestão do vínculo (CRUD)

Novos endpoints no módulo `gallery` (ou `clients`):

```
GET    /v1/clients/:id/preferred-images            → lista as preferidas do cliente
POST   /v1/clients/:id/preferred-images            { imageId }        → vincula
DELETE /v1/clients/:id/preferred-images/:imageId   → desvincula
```

(Opção B usaria os endpoints de pasta já existentes + associar pasta↔cliente.)

**Fluxo do usuário:** quando o cliente pede pra trocar a foto, o operador sobe/seleciona a
nova imagem na galeria e a vincula ao cliente — dali pra frente o matching passa a priorizá-la.

## 6. Frontend

- Passar `clientId` (do encarte atual) nas chamadas `matchImages` / `imageCandidates` em
  [aiService.ts](../../frontend/src/services/api/aiService.ts).
- Tela/aba de galeria filtrável por cliente ("Fotos deste cliente"), com ação de
  vincular/desvincular.
- Na revisão de imagens do encarte, badge "preferida do cliente" nas candidatas priorizadas.

## 7. Casos de borda

- **`clientId` ausente na chamada:** comportamento idêntico ao atual (sem boost).
- **Imagem preferida deletada da galeria:** `ON DELETE CASCADE` remove o vínculo.
- **Cliente deletado:** `ON DELETE CASCADE` limpa os vínculos.
- **Boost alto demais:** pode empurrar foto do cliente irrelevante pro topo; manter
  `PREFERENCE_BOOST` pequeno (~0.1–0.2) e sujeito a ajuste.
- **Imagem sem embedding:** já excluída por `embedding IS NOT NULL`; garantir backfill.

## 8. Testes

- Unit: com `clientId`, imagem preferida com similaridade próxima vence a não-preferida.
- Unit: sem `clientId`, ranking idêntico ao atual (regressão).
- Unit: sem foto preferida do produto, cai no banco geral normalmente.
- E2E: vincular imagem → `product-image-match` do produto passa a retornar essa imagem.
- Migration aplica limpo em banco com dados (VM de produção).

## 9. Faseamento

1. **Schema** do vínculo (Opção A) via SQL/migration + endpoints CRUD.
2. **Boost** em `searchByEmbedding` (V1) com `clientId` — ganho imediato.
3. Replicar boost na **V2** (`searchByMetadataEmbedding`).
4. **UI** de vínculo na galeria + passagem de `clientId` no match do editor.

## 10. Decisões

- **Modelo de dados:** escolhida a **Opção A** (tabela N:N `client_preferred_images`) pela
  flexibilidade e por evitar duplicar arquivos quando dois clientes preferem a mesma foto.
- **Priorização:** boost na distância cosseno (V1) + bump de score (V2), **não** filtro
  rígido — produto sem foto do cliente ainda encontra imagem no banco geral.
- **Preferência vence o score (V2):** havendo candidata preferida plausível, ela é escolhida
  sem passar por revisão (§4.2.1). Sem preferida, o fluxo por score é o de sempre.
