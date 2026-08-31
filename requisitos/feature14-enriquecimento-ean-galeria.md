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

#### Resultado medido em PRODUÇÃO (2026-08-30) — executado

Fila de 3.794 imagens drenada a zero em **~58 minutos**, zero falhas.

| | Antes | Depois |
|---|---|---|
| Consultáveis | 9.432 | **10.495** |
| % sobre imagens com metadata (12.815) | 73,6% | **81,9%** |
| Fila pendente | 3.794 | **0** |

**Ganho: +1.063 imagens consultáveis.**

Taxa de recuperação real: **~60%** (1.245 de 1.983 nas rodadas finais). O dry-run inicial havia
projetado 46,4%, mas ele amostrou as 500 mais antigas (`ORDER BY createdAt`), que têm filenames
piores que o resto da base — subamostragem.

**Sobre as projeções:** a primeira estimativa (~97%, extrapolada da base local, que rendeu 90,6%)
estava errada — filenames de produção são mais sujos, como o
[feature10](feature10-matching-imagem-produto-metadata.md) já registrava (`IMG_2401.jpg`,
`ruffles-final-v3.png`). A projeção corrigida após o dry-run de produção (~10.550) acertou:
o resultado foi 10.495, erro de 0,5%.

⚠️ **Lição para as fases seguintes: sempre medir em produção antes de extrapolar.** A base local
não representa a real, e o `dryRun` existe para isso.

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

#### Pendência aberta

`13.226` imagens na galeria mas apenas `12.815` com metadata — **411 imagens nunca tiveram
extração de metadata** e ficam fora do escopo da Fase 0 (que exige `metadata IS NOT NULL`).
Resolver com o endpoint já existente `POST /v1/ai/gallery/backfill-metadata` antes da Fase 2.

É a melhor relação retorno/esforço do plano inteiro e deve vir primeiro.

### Fase 1 — Decodificação local de código de barras (~1 dia, custo zero)

`zbar` ou ZXing sobre as 13.226 imagens + checksum GS1. Retorno esperado baixo (packshot
frontal raramente mostra o código), mas **o que render é 100% confiável e vira ground truth
para calibrar a precisão das fases seguintes**. Custo zero justifica rodar.

### Fase 2 — Open Food Facts — ✅ IMPLEMENTADA (resultado abaixo do esperado)

**Status: implementada e medida em 2026-08-30.**

#### Resultado medido

Ingestão do dump completo (4.535.554 linhas lidas em streaming):

| | |
|---|---|
| Produtos do Brasil | 34.110 |
| Descartados (GTIN implausível) | 823 |
| Gravados em `off_products` | 33.287 |
| Consultáveis (marca + quantidade) | 13.284 |

Dry-run da resolução sobre as 609 imagens consultáveis da galeria local:

| | qtd | % |
|---|---|---|
| Resolvidas automaticamente | 77 | **12,6%** |
| Ambíguas (fila de revisão) | 107 | 17,6% |
| Sem correspondência | 425 | 69,8% |

**O spec assumia que a OFF cobriria ~50% e cortaria o Cosmos pela metade. Ela cobre 12,6%.**

#### Por que — verificado, não é bug

Apenas **65 das 218 marcas** da galeria existem na `off_products` (30%). As ausentes são
marcas regionais brasileiras e não-alimentar: `always` (absorvente), `mu-mu`, `riversul`,
`q-tal`, `chum churum`, `top cau`, `famil`, `no lar`.

A OFF é de origem francesa, cobre **apenas alimentos** (Open Beauty Facts e Open Products
Facts são bases separadas e muito menores) e é fraca em marca regional brasileira. O matcher
entrega praticamente 100% do que o dado permite — 30% de sobreposição de marca produzindo
30,2% de imagens tocadas (12,6% automáticas + 17,6% revisáveis).

#### Balanço honesto

Como aposta de **cobertura**, a OFF decepcionou: resolve ~1.320 imagens em produção, que ao
preço do Cosmos custariam ~R$220. Não paga 1,5 dia de trabalho sozinha.

Como aposta de **fundação**, se pagou: `gtin.util` (checksum GS1, plausibilidade,
normalização de quantidade e marca), o bloco de proveniência no schema, a precedência entre
fontes e o padrão de serviço de resolução são todos reaproveitados pelo Cosmos, que agora é
majoritariamente esqueleto pronto.

**Upside não capturado:** as 107 ambíguas (17,6%) viram cobertura assim que a tela de revisão
da Fase 4 existir, levando a OFF de 12,6% para ~30%.

#### Implementação

- [gtin.util.ts](../src/modules/ai/ean/gtin.util.ts) — 36 testes
- [001_off_products.sql](../src/modules/ai/ean/sql/001_off_products.sql)
- [import-off-dump.ts](../src/modules/ai/ean/off-dump/import-off-dump.ts) — streaming, os 9 GB
  descomprimidos nunca tocam o disco
- [off-resolution.service.ts](../src/modules/ai/ean/off-resolution.service.ts)
- `GET /v1/ai/gallery/ean-stats`, `POST /v1/ai/gallery/resolve-ean-off`

**Filtro de plausibilidade — achado que mudou o desenho.** O checksum GS1 sozinho não filtra o
lixo da OFF: `00000086` ("Vegan protein powder") e `00002332` ("Contra Filé Mataboi", marca
alemã, 5 litros de carne) têm dígito verificador válido. O risco real é uma linha-lixo com
marca real e quantidade comum (`0000200375991 | SADIA | 200g`) casar com uma foto legítima e
gravar EAN falso. `isPlausibleRetailGtin()` exige 12+ dígitos e rejeita códigos iniciados em
`00` — GTIN emitido pela GS1 não começa com zeros. Descartou 823 linhas na ingestão.

### Fase 2 (planejamento original) — Open Food Facts (~1,5 dia, custo zero)

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

## Fase 2-bis — Precisão sem revisão humana (plano)

Investigação com três frentes paralelas (mineração do dump, mapeamento da infra existente,
pesquisa de resolução de entidades). Conclusões medidas, não estimadas.

### O reenquadramento

**Marca + quantidade é chave de BLOCKING, nunca de decisão.** Medido no dump brasileiro:
**59,9%** das chaves `(marca, quantidade)` são compartilhadas por 2+ produtos distintos; o
maior grupo tem 47 produtos. Numa amostra independente, **83,3%** dos produtos caem em algum
grupo de colisão.

```
camil 1000g   ×11 → arroz integral | feijão carioca | feijão preto | arroz tipo 1
tiojoao 1000g ×12 → integral | carnaroli | farinha de arroz | parboilizado
batavo 100g   ×16 → iogurte grego morango | pêssego | zero lactose
```

O token que decide é sempre a **variante**. E a resposta correta nos casos que falharam é
**rejeitar**, não escolher outro — o feijão Arisco não existe no dump.

### O sinal de abstenção é a MARGEM, não a confiança

Medição sobre consultas ruidosas contra o catálogo:

| Regra de aceite | Cobertura | Precisão |
|---|---|---|
| Aceitar sempre o top-1 | 100% | 75,3% |
| Score absoluto ≥ 0,5 | 100% | 75,3% |
| **Margem (top1 − top2) ≥ 0,2** | 59,0% | **100%** |
| Margem ≥ 0,2 + veto de empresa | **64,6%** | **100%** |

**Score absoluto não move a precisão em nada.** A margem entre 1º e 2º é o botão principal.

### Pipeline — aceitar só se TODAS as camadas passarem; qualquer falha ⇒ abstém

Abster manda a imagem para o Cosmos, não para fila humana.

| # | Camada | Custo | Efeito medido |
|---|---|---|---|
| 1 | Checksum GS1 + plausibilidade | zero | já implementado; descartou 823 linhas |
| 2 | Blocking por marca + quantidade normalizada | zero | reduz a ~13.284 candidatos |
| 3 | **Veto de empresa** — mapa `prefixo(7) → {marcas}` derivado do próprio OFF via `codes_tags` | zero | rejeita **86,9%** dos candidatos errados; falso veto **0,87%** |
| 4 | **Portão de variante** — exige token discriminante presente e nenhum token conflitante | zero | mata os falsos positivos Arisco e Divine |
| 5 | **Regra da margem** ≥ 0,2 | zero | o botão principal de precisão |
| 6 | **Verificador LLM** nos sobreviventes | ~US$0,0002/img | formato escolha-um-ou-NENHUM |
| 7 | *(opcional)* Veto de capítulo NCM via SEFAZ CCG | certificado e-CNPJ | única fonte independente que fecha o caso Arisco |

### Camada 3 — veto de empresa, sem depender da GS1

O EAN-13 embute o **GS1 Company Prefix**, que licencia a uma **empresa**. Não há base pública
prefixo→empresa (GEPIR limita a 30 consultas/dia; Wikidata P3193 tem 33 entradas no mundo,
zero brasileiras). **Mas o próprio OFF pré-computa os buckets** em `codes_tags`, e o mapa pode
ser derivado do dump que já temos. Verificado:

```
codes_tags=7891515xxxxxx → Sadia, Perdigão, Perdix, Qualy, Claybom, Becel  (= portfólio BRF)
```

Pureza prefixo→marca medida: 89,5% (L=7). A impureza residual **não é ruído — é propriedade
corporativa** (`78910970 → batavo, parmalat` = Lactalis). Por isso o modelo é
`prefixo → empresa → conjunto de marcas`, muitos-para-muitos.

⚠️ **O veto de empresa NÃO resolve o caso Arisco.** Tempero e feijão da mesma marca
compartilham prefixo. Ele mata falso positivo **entre** marcas, nunca **dentro** da marca.
Quem resolve dentro da marca é a camada 4 (variante) e, definitivamente, a 7 (NCM).

### Camada 7 — NCM, a fonte genuinamente independente

A SEFAZ expõe o **Cadastro Centralizado de GTIN** (NT 2022.001) em
`https://dfe-servico.svrs.rs.gov.br/ws/ccgConsGTIN/ccgConsGTIN.asmx`, retornando descrição
oficial, **NCM** e CEST. Exige certificado e-CNPJ A1 + mTLS.

| Produto | NCM | Capítulo |
|---|---|---|
| Feijão comum | 0713.33 | 07 — vegetais |
| Tempero composto ≤1kg | 2103.90.21 | 21 — preparações |

Capítulos diferentes. Um veto de capítulo elimina o falso positivo de forma determinística, e
por ser fonte externa ao OFF é a única que **multiplica** precisão de verdade.

### Correção: verificação visual não é o decisor

Registrado porque contradiz o que eu havia recomendado antes. Retrieval visual em supermercado
atinge **94,5% Recall@5 mas só 77,0% Recall@1** — os embeddings de SKUs distintos da mesma
marca colapsam num cone estreito em torno dos atributos visuais compartilhados. **A visão
sofre da mesma patologia do texto**: mesma marca, mesma embalagem, sabor diferente.

O que continua valendo: um **LLM lendo o rótulo** das duas fotos lado a lado é diferente de
similaridade de embedding — ele lê "Algodão Doce" vs "ao leite". Por isso a camada 6 é
verificador-que-lê, não comparador-de-vetores. E entra como veto, não como decisor.

### Cuidados obrigatórios com o verificador LLM

Juízes LLM binários são **sistematicamente superconfiantes** e têm viés pró-positivo. O prompt
precisa: passar o **conjunto** de candidatos pedindo *"escolha um OU responda NENHUM"* (o
pairwise isolado enviesa para "sim"); exigir **evidência desqualificante antes** da decisão;
tornar `NENHUM` o default explícito; e exigir que o modelo **cite o token de variante** que
justifica o match — sem token citado, abstém.

### Correções à primeira versão deste plano

**1. O verificador LLM ingênuo REPRODUZ o bug, não o conserta.** Na análise de erros do GPT-4
em Walmart-Amazon, **23 dos 26 falsos positivos** foram classificados como *"Overemphasis on
Matching Attributes"* — o modelo vê marca e tamanho batendo e responde "sim". É literalmente o
nosso caso Arisco. A camada 6 só funciona com o desenho invertido: **perguntar "o que difere?"
antes de "isto casa?"**, exigir terceira opção explícita (`NENHUM`/`INCERTO`), e obrigar o
modelo a **nomear e citar o atributo discriminante dos dois lados**. Sem atributo nomeado,
abstém. (E o número "95,4% com GPT-4o-mini como juiz" é post de blog, não revisado por pares.)

**2. Não usar votação "N de M sinais".** Não há literatura de resolução de entidades que a
endosse, e correlação a destrói: três sinais correlacionados concordando é um sinal
concordando três vezes. **Marca e quantidade são comprovadamente não independentes** — em
Fellegi-Sunter os pesos só são aditivos sob independência condicional, e o blocking já
condicionou em marca, então a probabilidade de concordância de quantidade *dentro do bloco* é
altíssima, não a coincidência rara que o cálculo global assume. Use **conjunções duras** (que
não precisam de calibração e não podem contar duas vezes) ou ajuste por frequência de termo,
para que concordância em valor raro pontue muito acima de valor comum.

### Modelo de saída em três níveis (resolve "sem fila humana")

Em vez de aceitar/rejeitar, emitir três estados — só o primeiro grava GTIN:

| Estado | Ação |
|---|---|
| `MATCH` | grava o EAN |
| `POSSIBLE` | **guarda o vínculo, não grava EAN** — não vira fila |
| `NO_MATCH` | segue para o Cosmos |

O `POSSIBLE` preserva a informação sem contaminar a base nem exigir humano.

### O preço da precisão é aritmético, não acidental

Cascata com taxa de falso positivo 0,5 e detecção 0,995 por estágio:

| Estágios | Falso positivo | Recall |
|---|---|---|
| 10 | ~9,8×10⁻⁴ | 95,1% |
| 20 | ~9,5×10⁻⁷ | 90,5% |

**Cobertura baixa não é efeito colateral — é o preço geométrico por camada.** Cada portão que
se adiciona compra precisão e paga em recall. Isso é exatamente a troca que o usuário aceitou.

### Onde a indústria realmente chega perto de 100%, não é com modelo

Referência de sobriedade: nos benchmarks, produto é a pior família. Ditto F1 — Amazon-Google
75,6; Abt-Buy 89,3; Walmart-Amazon 86,8; contra DBLP-ACM (bibliográfico) 99,0. Entidades não
vistas custam **10 a 30 pontos de F1**, e o nosso caso é quase todo não visto. **Nenhum sistema
publicado atinge precisão perto de 100% em product matching de mundo aberto.**

Quem chega lá usa outra coisa: a NIQ exige **fotos dos 6 lados** da embalagem com codificação
humana; Syndigo/1WorldSync resolvem por GTIN **declarado na origem pelo dono da marca** via
GDSN. Ou seja: quem tem precisão perfeita não adivinha — recebe o dado da fonte. É mais um
argumento a favor do ERP/NF-e como fonte, e um limite honesto para o que a OFF pode entregar.

### Garantia estatística de verdade: Conformal Selection

Para *afirmar* precisão (e não só medir num dev set), a ferramenta correta é **Conformal
Selection** (Jin & Candès, JMLR 2023): constrói p-valores conformais e aplica Benjamini-Hochberg
para controlar **FDR sobre o conjunto selecionado** — que é literalmente uma garantia de
precisão ("dos matches que aceito, ≤1% estão errados"). Exige apenas trocabilidade entre
calibração e teste. É o caminho para transformar "sem erros observados" em "erro controlado
em ≤X%".

### O sistema de produção mais próximo do nosso — e o teto que ele revela

*"Retrieve, Match, Escalate"* (arXiv 2608.25037) resolve **exatamente** o nosso problema:
registros de produto de comerciante → catálogo canônico **com GTIN**, mercearia, imagens.
Pipeline: retrieval híbrido (imagem + texto + GTIN, top-20) → cross-encoder de 150M →
escalonamento para VLM com busca web.

| Métrica | Valor |
|---|---|
| Recall do retrieval | 93–99% |
| **Barra de precisão 98% ⇒ auto-aceite de** | **43,7% dos pares** |
| Cobertura fim-a-fim (com escalonamento) | 77,1% |
| VLM agêntico vs operadores humanos | 96,7% acc / **99,1% precisão** |

**E ele explicitamente NÃO resolve "o produto não está no catálogo"** — que é justamente o
nosso caso dominante com a OFF (69,8% sem correspondência na medição local).

**Calibração de limiar que eles usam** (a receita): banda ALTA = *o menor score cuja precisão
implícita seja ≥98%*, derivada em dev set de 6k pares, validada contra auditoria independente
de 24k pares.

### O maior lever de precisão é gratuito e não é LLM

Em *"Entity Resolution in Practice"* (arXiv 2607.26298), **vetos duros em campos
identificadores** — zera a probabilidade quando ambos os registros têm o campo preenchido e a
similaridade fica abaixo de um piso — moveram a pureza dos clusters:

| Dataset | Antes | Depois |
|---|---|---|
| DBLP-Scholar | 95,4% | **99,5%** |
| Restaurants | 51,6% | **84,4%** |
| MusicBrainz | 77,7% | 89,7% |

Avaliação do próprio relatório: *"este mecanismo sozinho faz mais pela precisão do que
qualquer mudança de prompt neste relatório inteiro."* **Confirma a ordem de implementação:
camadas determinísticas primeiro, LLM só depois.**

Complemento: **limiares por esparsidade** (bins pelo número de campos preenchidos, com
monotonicidade forçada — registros mais esparsos exigem confiança maior) valeram +8,4pp de
pureza. Aplicável direto: uma imagem com título + marca + variante + quantidade deve enfrentar
barra menor que uma só com título truncado.

### Verificador LLM: os números de PRECISÃO (não F1)

*"Match, Compare, or Select?"* (arXiv 2405.16884, COLING 2025) é o único que reporta precisão:

| Estratégia | Precisão média | Recall | Custo |
|---|---|---|---|
| **Pareado Sim/Não** | **58,89%** | 78,17 | $4,52 |
| Comparação A-vs-B | 82,11% | 58,50 | $11,75 |
| **Seleção em lista** | **76,38%** | 87,83 | **$1,71** |
| **Filtrar → selecionar** | **83,08%** | 88,42 | **$1,67** |

Precisão do pareado em produto difícil: Abt-Buy **40,41**, Amazon-Google **35,54**,
Walmart-Amazon **35,62**. É a assinatura do viés de "sim" descontrolado.

**Conclusões duras:**
- **Seleção-em-conjunto vence pareado decisivamente (76,4% vs 58,9%) E custa 2,6× menos.**
- **Mesmo o melhor arranjo publicado dá 83% de precisão.** Nada na literatura de LLM-EM chega
  a 99% só com prompt.
- Viés de posição: F1 cai ~10 pontos conforme o match verdadeiro desce na lista. Manter k
  pequeno (4) e embaralhar entre amostras.

### Três instintos que a pesquisa desmente

1. **Auto-consistência (N amostras, exigir unanimidade) NÃO conserta o viés.** *"Um modelo pode
   concordar consigo mesmo por viés compartilhado."* Auto-consistência filtra **variância, não
   viés** — e o viés de "sim" é sistemático. Unanimidade em "match" não é evidência de precisão;
   unanimidade em "não" é sinal barato e útil.
2. **Confiança do LLM não serve de filtro.** Relabeling confidence *"noisy demais para ser
   filtro confiável"*; explicações auto-geradas *"divergem frequentemente dos fatores reais de
   decisão"*, com explicações confiantes para predições erradas. Forçar evidência é bom para
   **auditoria**, não como score.
3. **Zero-shot binário superprediz "sim" ~3×** (razão predita 6,23:1 contra 2,05:1 real). E o
   viés é parcialmente **do token de rótulo** — trocar qual token significa "match" desloca a
   resposta. Contrabalancear entre amostras.

### Correção: NÃO usar 789/790 como filtro de país

A GS1 é explícita: o prefixo *"identifica o escritório GS1 que o emitiu, não onde o produto
foi fabricado"*. Importado vendido no Brasil tem prefixo estrangeiro legítimo. O que vale é o
**veto de empresa** (prefixo → portfólio de marcas), não filtro geográfico. O nosso
`isPlausibleRetailGtin` rejeita apenas códigos iniciados em `00`, que é outra coisa e
permanece válido.

### O gargalo real do projeto é rotulagem, não código

Para *afirmar* ≥99% de precisão com zero erros observados (Clopper-Pearson, unilateral 95%):

| aceites rotulados | limite superior do erro | precisão afirmável |
|---|---|---|
| 100 | 2,95% | ≥ 97,0% |
| **299** | **1,00%** | **≥ 99,0%** |
| 2.995 | 0,10% | ≥ 99,9% |

**A armadilha:** `n` é o número de pares que o sistema **aceitou** e você rotulou — não o
tamanho do conjunto rotulado. Com taxa de aceite de 5%, obter 300 aceites exige rotular
**6.000 pares**. *"Normalmente esta é a restrição limitante do projeto inteiro."*

E se varrer vários limiares, o winner's curse invalida o intervalo: com 50 limiares testados,
o `n` necessário sobe ~2,3×. A correção certa é **Learn-then-Test** (Angelopoulos et al.) com
teste em sequência fixa — todo limiar devolvido já vem certificado, então pode-se escolher
entre eles livremente. É garantia de **alta probabilidade** (`P(precisão ≥ 99,5%) ≥ 0,95`),
mais forte que o FDR-em-esperança do cfBH, e são ~40 linhas.

### Expectativa e ressalva estatística honesta

**Trate 43,7% (a barra de 98% do sistema de produção equivalente) como a ponta OTIMISTA, não
como o meio da faixa.** Predição seletiva com risco garantido pode custar a maior parte da
cobertura em problemas difíceis de muitas classes — e casar produto contra catálogo aberto é
exatamente isso. Referência de calibração: no SGR, garantir 2% de risco no CIFAR-100 preserva
apenas **21%** do tráfego.

A estimativa anterior de "60–65%" veio de simulação com consultas sintéticas, não de sistema
em produção. **Planeje para menos.**

### Procedência das evidências deste plano

Auditoria feita em 2026-08-31 após uma das frentes de pesquisa retratar parte do próprio
relatório (material escrito de memória e apresentado como pesquisado, com identificadores
arXiv possivelmente inexistentes).

**Verificado por fetch nesta sessão — base das decisões de engenharia:**
tabela de precisão do ComEM (arXiv 2405.16884); vetos duros e limiares por esparsidade
(arXiv 2607.26298); pipeline e barra de 98%/43,7% (arXiv 2608.25037); viés de "sim" em juízes
binários; não-confiabilidade de logprobs e auto-explicações; auto-consistência não corrigir
viés; prefixo GS1 não indicar país de fabricação. Também verificadas textualmente:
Conformal Selection (Jin & Candès), Learn-then-Test (Theorem 1) e as tabelas de
Clopper-Pearson / regra dos três.

**Medições próprias, reproduzíveis nesta base:** contagens do dump da OFF, taxa de colisão de
`(marca, quantidade)`, sobreposição de marcas galeria↔OFF, curva de calibração local, e o
resultado do dry-run de resolução.

⚠️ **Antes de qualquer decisão de arquitetura baseada em literatura de conformal/selective
prediction além do que está acima, verificar a fonte primária.** Parte da bibliografia
originalmente citada não foi confirmada.

⚠️ Os 100% das tabelas vêm de ~260 itens selecionados. Pela regra dos três isso limita o erro
em **≲1,2%**, não prova 99,9%. Para *afirmar* 99% de precisão é preciso um dev set rotulado de
~300+ aceites; para 99,9%, milhares. **Construir esse dev set é entrega da Fase 2-bis**, não
opcional — sem ele não há como afirmar "sem erros", só "sem erros observados".

### Camadas 4 e 5 — implementadas e MEDIDAS (2026-08-31)

[variant-token.util.ts](../src/modules/ai/ean/variant-token.util.ts) — 26 testes, incluindo os
seis falsos positivos reais. Ligadas ao `OffResolutionService`.

| | antes (camadas 1-3) | depois (com 4 e 5) |
|---|---|---|
| resolved | 77 (12,6%) | **81 (13,3%)** |
| review | 107 | **40** |
| unresolved | 425 | 488 |

**A cobertura subiu**, confirmando o mecanismo previsto: o veto poda candidatos → alarga a
margem → recupera cobertura. A zona ambígua caiu 63%.

**Os seis casos que motivaram a camada: 6 de 6 corretos.** Arisco, Baton, Campeiro e Divine
rejeitados; e o par Caldo Nobre foi *separado* — `preto` aceito contra "Feijão Caldo Nobre -
Classe Preto", `carioca` rejeitado por conflito. Antes ambos recebiam o mesmo EAN.

#### ⚠️ Mas a precisão medida ainda é insuficiente

Auditoria dos 81 aceites revelou **colisões de GTIN** — o sinal mais duro de erro, porque uma
foto de produto distinto não pode compartilhar EAN:

| EAN | imagens distintas que o receberam |
|---|---|
| 7896062699961 | **5** — Solito Tipo 1 + Solito vitabon + Vitabom + Inari + Solito premium |
| 7896006711124 | **4** — Camil tipo 1, tipo 1 NOVO, **tipo 2**, food services |
| 7891008166330 | **3** — Garoto branco + **chocotrio bono** + tablete branco |
| 7622210999634 | **3** — Milka **oreo** + **happy cow** + **extra cocoa** |

Só as colisões implicam **≥11 erros certos entre 81 aceites (≥13,6%)**. Amostra manual de 18
encontrou ainda: Ferrero **Raffaello** → "Ferrero **Rocher**"; Schweppes **spritz** →
"Schweppes Água Tónica SIN AZÚCAR" (produto chileno, EAN 780).

**Precisão estimada: 80–86%.** Muito acima dos ~65% da regra antiga, e muito abaixo do alvo.

#### Causa raiz e as duas próximas camadas (ambas grátis e determinísticas)

**Causa:** os grupos discriminantes cobrem variante *genérica* (carioca, integral, meio amargo)
mas não **linha de produto / sub-marca** — `oreo`, `happy cow`, `raffaello`, `rocher`,
`chocotrio`, `diamante negro`. E o "token compartilhado" exigido pela regra 3 aceita palavra
comum: `chocolate` compartilhado entre uma foto de chocolate e uma linha de chocolate da OFF é
evidência nula, porque o blocking por marca já implicava a categoria.

**Camada 4b — exigir token RARO compartilhado (ponderação por frequência).** É o "term
frequency adjustment" do Splink e o "discriminative attribute" do DiffXtract: concordância em
valor raro deve pontuar muito acima de valor comum. Resolve `oreo`/`happy cow`/`raffaello` sem
precisar enumerar linha de produto.

**Camada 5b — unicidade global de GTIN.** Um GTIN não pode ser o aceite de duas imagens com
discriminantes conflitantes. Como não dá para saber qual está certa, **rejeitar todas**. É o
"veto duro em campo identificador" que a pesquisa apontou como o maior lever de precisão
(pureza 95,4% → 99,5% num benchmark).

### Resultado final das camadas determinísticas (2026-08-31)

Curva precisão × cobertura medida sobre as 609 imagens consultáveis da base local,
com auditoria manual de cada aceite:

| versão | aceites | erros claros | precisão auditada |
|---|---|---|---|
| original (marca + quantidade) | 77 | ~27 | ~65% |
| + camada 4 (variante) + 5 (margem) | 81 | ~14 | ~83% |
| + 4b (token raro) + 5b (unicidade GTIN) | 43 | 4 | ~91% |
| **+ 4c simétrica + 4d (quantidade)** | **20** | **0** | **20/20** |

**É exatamente o "preço geométrico por camada" que a pesquisa previa.** Cada portão comprou
precisão e pagou em cobertura.

Erros eliminados na última rodada (todos auditados individualmente):

```
Lacta ao leite 80g      → "Lacta DIAMANTE NEGRO"          eliminado
Lacta diamante Negro    → "Lacta LAKA"                    eliminado
Nestlé amendoim 150g    → "TABLETE CLASSIC AO LEITE"      eliminado
Nestlé alpino ao leite  → "meio amargo BLACK"             eliminado
Garoto branco 90g       → "Branco com Biscoito NEGRESCO"  eliminado
Lacta shot 80g          → "BISCOITO Cookie Shot"          eliminado
```

E um acerto novo apareceu: `Lacta - laka 90g` → `Laka`.

#### Camadas implementadas

| # | Camada | Arquivo |
|---|---|---|
| 4 | Portão de variante (conflito / subespecificação) | [variant-token.util.ts](../src/modules/ai/ean/variant-token.util.ts) |
| 4b | Token raro compartilhado (corte de FD em 0,5%) | idem |
| 4c | Atributo discriminante sem correspondência — **simétrico** | idem |
| 4d | Quantidade do metadata × quantidade do filename | [off-resolution.service.ts](../src/modules/ai/ean/off-resolution.service.ts) |
| 5 | Regra da margem (≥ 0,2) | idem |
| 5b | Unicidade global de GTIN | idem |

A camada 4d nasceu de um erro de extração real: `Tio Joao - tipo 1 5kg.jpg` tinha
`quantity: 1000g` no metadata. Blocking sobre quantidade errada casa com o produto errado, e
a discordância filename × metadata é detectável de graça.

A 4c precisou ser **simétrica**: só olhar galeria→candidato deixava passar o padrão residual,
em que o candidato é que carrega a linha de produto ("Diamante Negro", "Black", "Negresco")
ausente do título da galeria.

#### ⚠️ Duas ressalvas honestas

**1. Zero erros observados não é zero erros.** Com n=20 aceites e nenhum erro, o limite
superior de Clopper-Pearson a 95% é 3/20 = **15%**. O afirmável hoje é "precisão ≥ 85%", não
99%. Para afirmar 99% seriam necessários ~300 aceites auditados — e a 3,3% de taxa de aceite,
isso exige uma base de ~9.000 imagens consultáveis. A produção tem 10.495, então **é
alcançável**, mas exige a rodada em produção e a auditoria.

**2. A cobertura ficou marginal.** 20 de 609 = **3,3%**. Extrapolando para produção: a OFF
resolveria ~350 das 10.495 imagens consultáveis. O `review` caiu para 1 — quase tudo vira
`NO_MATCH` e segue para o Cosmos, que é o comportamento projetado, mas confirma que **a OFF é
hoje uma contribuinte pequena e precisa, não uma fonte principal.**

### Ordem de implementação

1. Mapa prefixo→marcas a partir do dump (camada 3) — zero custo, maior rejeição isolada
2. Portão de variante (camada 4) — zero custo, mata os falsos positivos conhecidos
3. Regra da margem (camada 5) — zero custo, é o botão principal
4. Dev set rotulado de ~300 aceites — mede a precisão real das camadas 1-5
5. Verificador LLM (camada 6) — só se o dev set mostrar que 1-5 não bastam
6. NCM/SEFAZ (camada 7) — só se houver certificado e-CNPJ disponível

As camadas 1-5 são **todas determinísticas e de custo zero**. Só se elas não bastarem é que
entra chamada de LLM.

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

Recalculado após a Fase 0 (10.495 consultáveis, contra 9.432 antes):

- ~8.350 chaves consultáveis distintas (dedup medido de 28,5%)
- +25% de retentativa com query alternativa → ~10.400
- **Com o pré-passe da OFF removendo ~50%** → **~5.200 consultas ao Cosmos**

### Cenários

**⚠️ Revisado em 2026-08-30 com a cobertura real da OFF (12,6%, não os ~50% assumidos).**

Restam ~9.175 imagens para o Cosmos → ~7.300 chaves distintas → **~9.100 consultas**.

| Cenário | Plano | Consultas | Dias corridos | Custo API |
|---|---|---|---|---|
| **Cosmos após OFF (recomendado)** | **Pro** | **~9.100** | **~18 dias** | **R$ 2.000** |
| Cosmos após OFF | Standard | ~9.100 | ~46 dias | R$ 2.000 |

**A OFF não cortou o custo pela metade.** O orçamento volta a R$2.000 e o Pro passa a ser a
escolha clara — mesmo preço do Standard, 2,5× mais rápido.

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
