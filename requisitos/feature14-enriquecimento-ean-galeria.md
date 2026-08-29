# Feature 14 — Enriquecimento de EAN das imagens da galeria

## Contexto

O pipeline de metadata da galeria já está construído e rodando: `gallery_images.metadata`
(jsonb) é populado por [image-metadata.service.ts](../src/modules/ai/metadata/image-metadata.service.ts)
via GPT-4o-mini vision, com schema Zod em
[product-metadata.schema.ts](../src/modules/ai/metadata/product-metadata.schema.ts) que **já
prevê o campo `ean`** (regex `^\d{8}$|^\d{12,14}$`), e há backfill administrativo em
`POST /v1/ai/gallery/backfill-metadata`.

O problema: **o campo `ean` está 100% vazio.**

Medição em produção (2026-08-29):

| Métrica | Valor | % |
|---|---|---|
| Imagens totais | 13.226 | 100% |
| `metadata_status = 'ready'` | 13.226 | 100% |
| **Com EAN** | **0** | **0%** |
| Consultáveis (têm marca **e** quantidade) | 9.432 | 71,3% |
| Sem marca ou sem quantidade | 3.794 | 28,7% |
| Chaves distintas (`marca+variante+quantidade`) | 9.451 | dedup de 28,5% |

Medição equivalente na base local (624 imagens): 100% `ready`, 98% com marca, 85% com
quantidade, 100% com categoria, **0% com EAN**, e nenhum filename contendo 8–14 dígitos.

Não é bug. O prompt instrui `NÃO invente EAN/SKU. Só preencha se estiverem claramente
legíveis` ([image-metadata.service.ts:151](../src/modules/ai/metadata/image-metadata.service.ts))
— e packshot de catálogo mostra a frente da embalagem, onde o código de barras não aparece.
A restrição está correta e deve ser mantida; a fonte é que não existe na imagem.

### Achado crítico — EAN só na imagem não melhora o matching

O EAN entra em exatamente um ponto do código: `idScore()` em
[product-image-match-v2.service.ts:275](../src/modules/ai/metadata/product-image-match-v2.service.ts),
com peso `0.40`, e **exige EAN nos dois lados**:

```ts
if (product.ean && image.ean && product.ean === image.ean) return 1;
```

O lado "produto" vem de planilha, e o próprio código já documenta que planilha nunca traz EAN
— daí o `WEIGHTS_NO_ID`, que redistribui os `0.40` entre marca/categoria/texto/pack. O
importador confirma: [flyerSpreadsheetImporter.ts](../../frontend/src/services/import/flyerSpreadsheetImporter.ts)
só extrai nome/preço/categoria e descarta colunas de código.

**Consequência:** popular EAN apenas na galeria mantém `idScore = 0` e `WEIGHTS_NO_ID` ativo.
O ganho de matching só existe se vier junto com uma das duas coisas:

1. EAN também no lado do produto (Fase 5 deste documento), **ou**
2. Enriquecimento — usar o EAN como chave para puxar marca/variante/quantidade/categoria
   normalizadas de uma base externa, o que move os `0.80` de peso restantes.

O valor independente do EAN (mesmo sem tocar no matching) é: chave canônica para
deduplicação da galeria, e integração futura com o ERP dos clientes.

---

## Decisões já tomadas com o usuário

- **Estratégia híbrida aprovada:** Open Food Facts (dump gratuito, offline) resolve a maioria;
  Bluesoft Cosmos (API paga) resolve o restante.
- **Fonte paga escolhida:** Bluesoft Cosmos. GS1/CNP descartada nesta iteração (exige
  associação, cara, e otimizada para consulta *por* GTIN e não para resolução reversa por
  descrição). Bases genéricas (UPCitemdb, Barcode Lookup, Go-UPC) descartadas por cobertura
  BR fraca.
- **Trabalhar por chave distinta**, não por imagem — uma resolução propaga o EAN para todas as
  imagens que compartilham `marca+variante+quantidade`. Reduz consultas e revisão em ~28%.
- **Nunca deixar o LLM inventar EAN.** A regra atual do prompt permanece intacta.
- **Todo EAN é validado por checksum GS1** antes de ser gravado, qualquer que seja a fonte.
- **Proveniência obrigatória** — o EAN nunca é gravado como string solta.
- **Piloto antes de assinar plano pago** (ver Fase 3).

### Em aberto (bloqueia decisão de orçamento)

- **Objetivo final não confirmado.** Se for melhorar o matching, a Fase 5 é obrigatória e
  possivelmente deveria vir primeiro. Se for dedup / catálogo canônico / integração com ERP,
  a ordem muda.
- **Cobertura do Cosmos em não-alimentar** é a maior incógnita técnica do plano. Medida pelo
  piloto.
- **Taxa real de auto-aceite** — todo o cálculo de revisão humana depende dela. Medida pelo
  piloto.

---

## Regras de Negócio

- O enriquecimento é **assíncrono e em lote** (job administrativo), nunca no caminho crítico
  de upload nem de renderização de encarte.
- Um EAN só é gravado automaticamente quando **marca e quantidade** batem com a candidata.
  Qualquer outro caso vai para **fila de revisão humana** — nunca é aceito no escuro.
- Um EAN que falhe no **checksum GS1** é descartado silenciosamente, independentemente da
  fonte. Não vai nem para revisão.
- A ordem das fontes é fixa e cada uma só processa o que a anterior não resolveu:
  `barcode local → filename parse → Open Food Facts → Cosmos → revisão humana`.
- Fonte de maior confiança **nunca** é sobrescrita por fonte de menor confiança. Precedência:
  `manual > erp > barcode-scan > cosmos > off`.
- A revisão humana é sempre a palavra final e sobrescreve qualquer fonte automática.
- O job deve ser **retomável** — respeitar cota diária, parar ao atingi-la, e continuar de onde
  parou no dia seguinte sem reprocessar o que já foi resolvido.
- Imagens sem marca **e** sem quantidade após todas as fases ficam com `ean: null` e
  `eanStatus: 'unresolved'`. Não é erro.

---

## Arquitetura Técnica

### Schema — bloco de EAN dentro de `metadata` (jsonb)

O EAN **nunca** é gravado como string solta. Sem proveniência, em três meses não se sabe quais
valores confiar:

```jsonc
{
  "ean": "7891000100103",
  "eanSource": "barcode-scan" | "off" | "cosmos" | "manual" | "erp",
  "eanConfidence": 0.95,
  "eanVerifiedAt": "2026-08-29T14:22:00Z",
  "eanStatus": "resolved" | "review" | "unresolved",
  "eanCandidates": [
    { "ean": "7891000100103", "source": "cosmos", "score": 0.72, "description": "..." }
  ]
}
```

O campo `ean` já existe no `ProductMetadataSchema`; os demais são novos e devem ser
adicionados ao schema Zod como opcionais, para não invalidar os 13.226 registros existentes.

### Índices

```sql
-- lookup e dedup por EAN
CREATE INDEX IF NOT EXISTS gallery_images_ean_idx
  ON gallery_images ((metadata->>'ean'))
  WHERE metadata->>'ean' IS NOT NULL;

-- fila de revisão e retomada do job
CREATE INDEX IF NOT EXISTS gallery_images_ean_status_idx
  ON gallery_images ((metadata->>'eanStatus'))
  WHERE metadata->>'eanStatus' IN ('review', 'unresolved');
```

Seguem o padrão de [001_pgvector_setup.sql](../src/modules/gallery/sql/001_pgvector_setup.sql)
— idempotentes, aplicados no boot.

### Validação de checksum GS1

Obrigatória, ~10 linhas, elimina de saída todo EAN alucinado ou digitado errado. Aplica-se a
EAN-8, EAN-13, UPC-A (12) e GTIN-14.

```ts
export function isValidGtin(raw: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(raw)) return false;
  const digits = raw.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // pesos 3/1 alternados da direita para a esquerda
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}
```

### Estrutura de arquivos

```
src/modules/ai/ean/
├── ean.module.ts
├── gtin.util.ts                      # checksum GS1 + normalização
├── ean-resolution.service.ts         # orquestrador das fontes, precedência, persistência
├── ean-query-builder.ts              # metadata → string de busca normalizada
├── sources/
│   ├── barcode-decoder.source.ts     # zbar/ZXing local
│   ├── open-food-facts.source.ts     # lookup no dump local
│   └── cosmos.source.ts              # cliente HTTP + rate limiter + retry 429
└── off-dump/
    └── import-off-dump.ts            # ingestão do dump para tabela local
```

### Endpoints (admin, protegidos por `x-admin-token`)

Seguem o padrão das rotas administrativas já existentes em
[ai.controller.ts](../src/modules/ai/ai.controller.ts).

```
GET  /v1/ai/gallery/ean-stats            # contagem por eanStatus e por eanSource
POST /v1/ai/gallery/backfill-ean         # dispara o job; body: { source?, batchSize?, dryRun? }
GET  /v1/ai/gallery/ean-review           # fila paginada de candidatos ambíguos
POST /v1/ai/gallery/ean-review/:imageId  # decisão humana; body: { ean | reject }
```

### Variáveis de ambiente

```
COSMOS_API_TOKEN=
COSMOS_DAILY_QUOTA=200            # espelha o plano contratado; o job para ao atingir
COSMOS_ENABLED=true
OFF_DUMP_PATH=./data/off-products.db
AI_EAN_ENABLED=true
```

---

## Fases de Implementação

### Fase 0 — Recuperar os 3.794 sem marca/quantidade — ✅ IMPLEMENTADA

**Status: implementada e validada na base local em 2026-08-29.**

28,7% da base não é consultável por descrição porque falta marca ou quantidade no metadata.
Mas **os filenames já codificam essa informação**:

```
Oliron - 5kg.jpg              Tio Joao - arborio 500g.jpg
Solito - fradinho 500g.jpg    Lacta - amandita 200g 002.jpg
```

E o parser já existe: [ProductNameParserService](../src/modules/ai/metadata/product-name-parser.service.ts)
transforma nome livre exatamente no `ProductMetadata` necessário. Rodar os 3.794 filenames por
ele antes de qualquer consulta paga.

#### Resultado medido (base local, 624 imagens)

| | Antes | Depois |
|---|---|---|
| Consultáveis | 528 (84,6%) | **609 (97,6%)** |
| Pendentes | 96 | **0** |

Dry-run sobre as 96 pendentes: **87 recuperadas (90,6%)**, 9 sem recuperação, 0 falhas.
Campos recuperados: `quantity` 81, `variant` 20, `packageType` 2, `category` 1.

**Projeção para produção:** 3.794 pendentes × ~90% ≈ 3.400 recuperadas, levando os consultáveis
de 9.432 (71,3%) para **~12.850 (97%)**.

⚠️ **A taxa de 90,6% vem da base local, que pode ter filenames mais limpos que produção.** O
[feature10](feature10-matching-imagem-produto-metadata.md) registra que existem nomes como
`IMG_2401.jpg` e `ruffles-final-v3.png` na base real, dos quais nada é recuperável. Rode o
dry-run em produção antes de aplicar — ele mede a taxa real sem escrever nada e sem custo de
API paga.

#### Implementação

- [filename-metadata-recovery.service.ts](../src/modules/ai/metadata/filename-metadata-recovery.service.ts)
  — 10 testes em [filename-metadata-recovery.spec.ts](../src/modules/ai/metadata/filename-metadata-recovery.spec.ts)
- `GET  /v1/ai/gallery/filename-recovery-stats` — cobertura atual e tamanho da fila
- `POST /v1/ai/gallery/filename-recovery` — body `{ batchSize?, maxBatches?, dryRun? }`

**Garantias de segurança do merge** (cobertas por teste):

- Preenche apenas lacunas. Marca, variante, quantidade ou categoria já extraídas pela visão
  **nunca** são sobrescritas — a visão olha a foto, o filename é digitação de operador.
- Toda recuperação deixa rastro em `warnings` (`filename-recovery: quantity,variant`).
- Re-gera o `metadata_embedding` após o merge, já que `buildEmbeddingText` usa
  marca/variante/quantidade — sem isso o matcher V2 continuaria vendo o metadata antigo.
- Linhas já tentadas saem da fila mesmo sem recuperação (marcador `filename-recovery: none`),
  o que torna o job retomável e evita que ele trave. **Sem essa marcação o job entra em loop
  em produção:** com ~380 linhas irrecuperáveis e `batchSize=50`, todo lote releria as mesmas
  50 e nunca avançaria. Detectado no teste local (`scanned: 139` para 96 imagens únicas) e
  corrigido.

É a melhor relação retorno/esforço do plano inteiro e deve vir primeiro.

### Fase 1 — Decodificação local de código de barras (~1 dia, custo zero)

`zbar` ou ZXing sobre as 13.226 imagens + checksum GS1. Retorno esperado baixo (packshot
frontal raramente mostra o código), mas **o que render é 100% confiável e vira ground truth
para calibrar a precisão das fases seguintes**. Custo zero justifica rodar.

### Fase 2 — Open Food Facts (~1,5 dia, custo zero)

Dump completo, gratuito, offline, **sem cota e sem limite de consultas**. Cobre alimentos e
bebidas. Ingerir para tabela local indexada por marca+quantidade normalizadas e resolver o
subconjunto alimentar antes de tocar no Cosmos.

Cobertura estimada: **~50% da base** para sortimento de supermercado completo — a confirmar
no piloto. Não cobre higiene, limpeza e não-alimentar em geral.

Este é o passo que corta o orçamento pela metade: 1,5 dia de dev que economiza ~R$1.000 de
API e ~10 dias de janela.

### Fase 3 — Piloto Cosmos (3 a 12 dias, R$0 a R$500)

**Antes de assinar qualquer plano.** 300 chaves estratificadas por categoria (alimento,
limpeza, higiene, bebida) para medir as duas variáveis que decidem o resto do orçamento:

- taxa real de auto-aceite (marca + quantidade batendo)
- cobertura do Cosmos em não-alimentar

Cabe no plano **Basic gratuito** (25/dia → 12 dias) ou em **R$500 no Simple** (3 dias).

Justificativa: se o auto-aceite for 40% em vez dos 65% assumidos, a revisão humana salta de
~12h para ~25h e o projeto muda de figura. Gastar R$500 para não errar uma decisão de
R$1.000–2.000 + 8 dias de dev + 12h de revisão é o trade correto.

### Fase 4 — Backfill Cosmos + revisão humana (~3,5 dias de dev + ~12h de revisão)

Job em lote respeitando a cota diária, com fila de revisão para os ambíguos.

### Fase 5 — Fechar o lado do produto (~1,5 dia)

**Obrigatória se o objetivo for melhorar o matching.** Sem ela, `idScore` permanece 0 e nada
das fases anteriores move o score.

- Coluna `ean` em `products` (hoje a entidade só tem `sku` —
  [product.entity.ts](../src/modules/products/entities/product.entity.ts))
- Detecção de coluna de código de barras no
  [flyerSpreadsheetImporter](../../frontend/src/services/import/flyerSpreadsheetImporter.ts),
  que hoje descarta qualquer coluna de código
- Campo de EAN no cadastro manual de produto
- Reavaliar `WEIGHTS` vs `WEIGHTS_NO_ID` depois que ambos os lados tiverem cobertura real

**Fonte mais barata e precisa de todas:** o EAN já existe dentro dos clientes — no ERP, nos
XMLs de NF-e e provavelmente nas próprias planilhas de encarte enviadas. Verificar se alguma
planilha recebida traz coluna de código de barras; se trouxer, essa fonte é gratuita, 100%
precisa, e muda a prioridade de todo o plano.

---

## Custos e Prazos

### Preços da API Cosmos (verificados em 2026-08-29)

Fonte: https://cosmos.bluesoft.com.br/api-pricings

| Plano | Preço | Consultas/dia | Consultas/mês | R$/consulta |
|---|---|---|---|---|
| Basic | grátis | 25 | 750 | — |
| Simple | R$ 499,99/mês | 100 | 3.000 | R$ 0,167 |
| Standard | R$ 999,99/mês | 200 | 6.000 | R$ 0,167 |
| Pro | R$ 1.999,99/mês | 500 | 15.000 | R$ 0,133 |
| Enterprise | negociar | — | — | — |

**A cota é diária, não mensal** — este é o fato que domina o planejamento. Excedente responde
HTTP 429. Endpoint de busca: `GET /products?query={descrição ou gtin}`, paginado (30 por
página, até 90 via `per_page`).

Observação: o custo total é praticamente idêntico em qualquer plano. **O que se compra ao
subir de plano é tempo, não dinheiro.** Pro é simultaneamente o mais rápido e o mais barato
por consulta — entre os planos de prateleira não há trade-off.

### Volume estimado de consultas

- ~7.500 chaves consultáveis distintas (faixa 6.700–8.300, **pendente de medição exata**)
- +25% de retentativa com query alternativa → ~9.400
- **Com o pré-passe da OFF removendo ~50%** → **~4.700 consultas ao Cosmos**

### Cenários

| Cenário | Plano | Consultas | Dias corridos | Custo API |
|---|---|---|---|---|
| **Cosmos + OFF (recomendado)** | **Standard** | **~4.700** | **~24 dias** | **R$ 1.000** |
| Cosmos + OFF, mais rápido | Pro | ~4.700 | ~9,5 dias | R$ 2.000 |
| Cosmos sem OFF | Pro | ~9.400 | ~19 dias | R$ 2.000 |
| Cosmos sem OFF | Standard | ~9.400 | ~47 dias | R$ 2.000 |

Com a OFF, o Standard resolve tudo **dentro de um único ciclo de faturamento por R$1.000** —
metade do orçamento do cenário sem OFF.

Para volumes concentrados, vale pedir cotação Enterprise para *"20.000 consultas em janela de
7 dias, carga única de backfill"* — é um pedido de burst, não recorrente.

### Esforço de engenharia

| Item | Estimativa |
|---|---|
| Fase 0 — parser de filename (reusa serviço existente) | 0,5 dia |
| Fase 1 — decodificação local de barcode | 1 dia |
| Fase 2 — ingestão do dump OFF | 1,5 dia |
| Cliente Cosmos + rate limiter + retry 429 | 1 dia |
| Query builder + matcher (marca/qtd + checksum GS1) | 1,5 dia |
| Job de backfill com cota diária, retomada e proveniência | 1,5 dia |
| Tela de revisão da fila de ambíguos | 2 dias |
| Fase 5 — lado do produto | 1,5 dia |
| **Total** | **~10,5 dias** |

### Revisão humana

Trabalhando por chave distinta (uma resolução propaga para todas as imagens da chave):

- ~7.500 chaves × 65% de auto-aceite = 4.875 automáticas
- **~2.600 chaves para revisão × ~17s ≈ 12 horas**

O dedup de 28,5% é o que mantém esse número em 12h em vez de ~25h.

### Orçamento consolidado (cenário recomendado)

| Item | Valor |
|---|---|
| API Cosmos (Standard, 1 mês) | R$ 1.000 |
| Piloto (Basic gratuito) | R$ 0 |
| Dev | ~10,5 dias |
| Revisão humana | ~12 horas |
| Tempo de relógio do backfill | ~24 dias |

---

## Medições pendentes

O número exato de chaves consultáveis distintas ainda não foi medido — a query executada em
produção contou `DISTINCT` sobre a base inteira, sem o filtro do subconjunto consultável. As
linhas sem marca colapsam em chaves vazias e distorcem o total. Rodar em produção:

```sql
WITH k AS (
  SELECT
    lower(unaccent(coalesce(metadata->'alternatives'->0->>'brand',''))) AS marca,
    lower(unaccent(coalesce(metadata->'alternatives'->0->>'variant',''))) AS variante,
    coalesce(metadata->'quantity'->>'value','') ||
    coalesce(metadata->'quantity'->>'unit','')  AS qtd
  FROM gallery_images
)
SELECT COUNT(DISTINCT (marca||'|'||variante||'|'||qtd))
FROM k
WHERE marca <> '' AND qtd <> '';
```

O resultado ajusta proporcionalmente todo o dimensionamento de consultas, custo e revisão
deste documento.

---

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Cobertura do Cosmos em não-alimentar abaixo do esperado | Alto — é o subconjunto que a OFF não cobre | Piloto estratificado por categoria (Fase 3) antes de assinar |
| Taxa de auto-aceite < 65% | Médio — dobra a revisão humana | Piloto mede antes do compromisso |
| Convenção de filename não se sustenta nas 13.226 | Médio — Fase 0 rende menos | Amostragem antes de implementar; o custo é 0,5 dia |
| Cota diária torna o backfill longo demais | Baixo — é job de fundo, não bloqueia nada | OFF corta pela metade; Enterprise se houver urgência |
| Dados do Cosmos vêm imprecisos | Médio | A própria Bluesoft recomenda revisão; checksum GS1 + match de marca/qtd + fila de revisão |
| EAN gravado sem proveniência | Alto — inviabiliza auditoria futura | Bloco de proveniência obrigatório desde o primeiro registro |

---

## Follow-ups (fora desta iteração)

- **Casamento imagem↔imagem via pgvector contra a base da OFF**, que distribui as fotos junto
  com o dump. Reaproveita a infra de embeddings e HNSW já existente
  ([gallery-embedding.service.ts](../src/modules/ai/gallery-embedding.service.ts)) e herda o
  EAN por similaridade visual. Elegante, mas maior esforço e cobre só o subconjunto alimentar.
- **Captura no ponto de uso** — scanner de código de barras via câmera no cadastro de produto.
  Não resolve backfill, mas garante que a base nasça limpa daí em diante. É como toda base de
  GTIN madura foi construída.
- **Ingestão direta de XML de NF-e / integração com ERP dos clientes** como fonte de EAN
  autoritativa e gratuita.
- **Deduplicação da galeria por EAN** depois que a cobertura estiver madura.
