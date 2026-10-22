# Design: peça de ofertas configurável

Estado: **proposta técnica para discussão** (22/10/2026). Produto e usabilidade
fechados no doc "Comercial de ofertas configurável". As seções "Decisões de
produto", "Princípios do editor" e "Auto-layout" vêm daquele doc; o resto é a
solução proposta depois de explorar o código do backend e do frontend.

## Decisões de produto (fechadas em 22/10/2026)

| Tema | Decisão |
| --- | --- |
| Onde o cliente monta a peça | Editor novo, feito do zero para o vídeo, livre e com auto-layout. Não reaproveita o editor de encartes; se ficar bom, vai para o encarte depois. |
| Fotos dos produtos | Sempre da galeria (produtos já cadastrados). Foto única enviada pelo cliente fica como alternativa. |
| Personagem | Dentro da peça (recorte posicionado) e rosto do logo no lançamento; janela continua como está. |
| Produtos | Até 12 na tela, até 6 falados. |
| Legendas | Opcionais, desligadas por padrão. |
| Trilha | Opcional, paga. |
| Formatos | 9:16 e 4:5 no lançamento. |
| Modelos | Por conta, reutilizáveis entre clientes (logo e rodapé trocam pelo cliente). |
| Limites | Um personagem por peça; até 5 textos soltos; fontes da conta; imagem de fundo até 10 MB. |

## Princípios do editor

- **O sistema propõe, o cliente ajusta.** Marcar produtos já produz uma peça
  apresentável; cada ajuste é opcional.
- **Prévia fiel.** O que o editor desenha é exatamente o quadro do vídeo: o
  mesmo componente desenha a prévia e o quadro parado do vídeo.
- **Peça parada, personagem vivo.** O vídeo é a peça estática mais a região
  animada do personagem. Movimento de blocos não existe nesta change.
- **Nada herdado do editor de encartes.** Conceitos, telas e modelo de dados
  nascem aqui.

## O que já existe e é reaproveitado (achados da exploração)

- **Executor da "arte que fala" (F1)**: por frase, `tts → talk`; por projeto,
  `compose_ffmpeg → finalize`. O compose faz loop de uma imagem parada e
  sobrepõe os clipes do personagem numa janela em frações do quadro, com fade
  entre clipes e 200 ms de intervalo; o finalize queima legendas, mistura
  trilha e normaliza (`domain/mc-talking-art-graph.ts`, `mc-finalize-graph.ts`).
  **É exatamente o vídeo da peça**: a "arte" passa a ser o quadro parado
  renderizado da peça e a "janela" passa a ser o bloco do personagem.
- **Diretor do carrossel (F2)**: abertura, uma frase por oferta na ordem,
  fechamento, preço por extenso, encurtamento automático até 30 s
  (`domain/mc-director.ts`, `buildDirectorSystemPromptF2`). É a fala da peça.
- **Rosto do logo**: kit `logo_as_is`, motor H3 Max, caixa do logo em frações
  da arte, cor do entorno amostrada (`domain/mc-logo-face.ts`). Na peça, a
  caixa é o próprio bloco da logo: não precisa de detecção.
- **Reaproveitamento por hash**: TTS = texto + voz; talk = motor + tile +
  áudio + prompt + cor (sem aspecto). Duplicar formato clona os TTS como
  `skipped_cached` e o talk vem do cache. "Refazer só esta fala" já existe
  (`POST scenes/:id/reroll`, `PATCH scenes/:id/dialogue`, previews de voz).
- **Renderizador com navegador** já roda no worker para o F2 (Remotion,
  `MC_RENDER_BROWSER`, pacote `@chroma/video-templates` em
  `MC_VIDEO_TEMPLATES_DIR`), com `renderMedia`; serve também para `renderStill`.
- **Frontend**: previews em DOM/CSS com frações do quadro, `react-rnd` para
  arrastar/redimensionar, fontes da conta injetadas por `@font-face`,
  pickers de galeria/produto/logo prontos, TanStack Query com
  `expectedRevision` e SSE para progresso.

## Solução proposta

### 1. Descritor da peça: entidade própria `mc_pieces`

A peça é um objeto de primeira classe, editada antes de existir projeto, com
autosave, e também é o que vira "modelo". Tabela `mc_pieces`:

| Coluna | Tipo | Nota |
| --- | --- | --- |
| id, userId | uuid | dono |
| clientId | uuid, nullable | nulo em modelo |
| kind | `piece` \| `template` | modelo = peça sem produtos |
| name | varchar(120) | |
| aspectRatio | varchar(10) | 9:16, 4:5 |
| document | jsonb | o descritor (abaixo), teto 2 MB |
| revision | int | lock otimista (`expectedRevision`, 409) |
| createdAt, updatedAt | timestamptz | |

Descritor (`schemaVersion: 1`), tudo em **frações do quadro** (mesma
convenção da janela e da caixa do logo):

```
{ schemaVersion: 1, aspectRatio, 
  background: { mode: 'solid'|'gradient'|'image', color?, colors?, angle?,
                imageUrl?, fit?, blur?, darken? },
  blocks: [
    { id, type: 'logo',    rect, zIndex, imageUrl },
    { id, type: 'text',    rect, zIndex, text, fontId?, fontSize, color, align, weight },
    { id, type: 'footer',  rect, zIndex, style: 'bar'|'pill', address, phone,
                            validity: { from, to }, legal, colors },
    { id, type: 'products', rect, zIndex, mode: 'grid'|'single',
                            layout: 'auto'|'manual', areaStyle: { background?, radius, shadow },
                            tagStyle: { kind, color, textColor },
                            items: [ { id, catalogId, name, grams?, unit?, price, originalPrice?,
                                       imageUrl, rect?, featured?, spoken: true|false } ],
                            singleImageUrl? },
    { id, type: 'character', rect, zIndex, kitId, mode: 'in_piece'|'logo_face',
                            panel: { shape: 'none'|'card'|'circle', color } }
  ] }
```

- Produtos entram **congelados** (nome, preço de/por, unidade, foto da galeria)
  com `catalogId` para o aviso "preço mudou" (mesma comparação de
  `offersCatalogChanges`). Foto só de `/uploads/` (anti-SSRF, como hoje).
- Validação em duas camadas, como o `script` v2: DTO com `@ValidateNested` por
  tipo de bloco (o pipe global tem `forbidNonWhitelisted`) e um validador puro
  do domínio (`validatePieceDocument`) com limites: 2 a 12 produtos, até 6
  `spoken`, até 5 textos, um personagem, blocos dentro do quadro, lado menor
  do personagem ≥ 25% da largura.
- O **projeto** ganha `pieceId` e `pieceSnapshot` (jsonb, cópia imutável no
  momento de gerar). O `script` continua a fonte das falas; a peça é a fonte
  do quadro.

### 2. Render da peça parada: quadro único no servidor, pelo mesmo componente

- Um componente React `PieceCanvas(document, dims)` vive no pacote
  `@chroma/video-templates` e é usado nos dois lados: no editor (prévia em DOM,
  escala por CSS como o `ClientFooterEditor`) e no worker (`renderStill` do
  Remotion com o navegador já configurado para o F2). É isso que garante
  "prévia = quadro final" sem comparação de pixels.
- Novo step de projeto `render_still` (antes do compose), hash = descritor
  canônico + versão da composição + fontes. Produz o asset `piece_still`
  (PNG 1080p do formato). Mudar só a fala não re-renderiza o quadro.
- Fontes da conta: o worker carrega os arquivos de `/uploads/fonts/` por URL
  absoluta (`MC_RENDER_ASSET_BASE_URL`), com `delayRender` até carregar.
- O vídeo: `compose_ffmpeg` do F1 com `backgroundArt = piece_still` e
  `window = rect do bloco personagem`. Sem `fill` nem pad: o still já tem o
  tamanho de saída. Depois `finalize` como hoje.
- Alternativa descartada: rasterizar no navegador do cliente e subir como
  `video_art`. Prévia e quadro só coincidem por sorte (fontes, DPR), e o
  servidor não consegue regerar o quadro quando um preço muda ou o formato é
  duplicado.

### 3. Personagem dentro da peça: painel liso no lançamento, chroma depois

Os motores devolvem clipe opaco; o tile é achatado numa cor antes do submit.
Sobre uma foto ou degradê isso vira um retângulo visível. Três caminhos:

| Caminho | Como | Risco |
| --- | --- | --- |
| (a) Painel liso do personagem | O bloco personagem sempre tem um painel (card arredondado ou círculo) numa cor escolhida; o tile é achatado nessa cor, o clipe entra sem recorte. É o que o F1 faz e o que o Piccin faz (moça sobre azul liso). | Nenhum técnico; limita o visual a "personagem num painel". |
| (b) Chroma key | Tile achatado em verde (#00FF00), `chromakey` no compose, overlay com alfa sobre a peça. | Motor pode alterar a cor/iluminação do fundo; serrilhado em cabelo; roupa verde. Exige bake-off por motor. |
| (c) Alfa do motor | Nenhum motor em uso devolve alfa. | Indisponível. |

Proposta: **(a) no lançamento**, com o painel podendo ter a cor do fundo da
peça (cor sólida) para parecer "sem painel"; **(b) como opção "fundo
transparente" na fase 2**, depois de um bake-off com os clipes reais dos
três motores (Kling standard/pro, H3 Max).

### 4. Rosto do logo: reaproveitado como está

Bloco `character` em `mode: 'logo_face'` exige kit `logo_as_is`; o `rect` do
bloco é a caixa do logo (`logoBoxConfirmed: true` por construção). O compose
usa o caminho logo-face do F1 (motor H3 Max, cor do entorno amostrada do
still em volta do rect). Nenhum contrato muda.

### 5. Reaproveitamento das falas: o mecanismo atual atende

- Duplicar 9:16 → 4:5: clona a peça com o auto-layout no novo formato, clona os
  TTS como `skipped_cached`, talk vem do cache (hash sem aspecto), `render_still`
  e `compose` são novos. Mesmo fluxo de `duplicateProject`, com `pieceId` novo.
- Preço mudou: editar o produto na peça com `spoken: true` reescreve a frase
  pelo line builder do F2 e volta à revisão do roteiro (só aquele TTS/talk
  mudam de hash); mudança só visual (foto, ordem, estilo) abre revisão
  `assembly_only` (render_still + compose + finalize). É a regra do
  `PATCH /composition` do F2, aplicada ao descritor.
- Refazer só uma fala: `POST scenes/:id/reroll` e previews de voz, sem mudança.

### 6. Modelos: `mc_pieces` com `kind = 'template'`

Salvar como modelo copia o descritor sem `items` do bloco de produtos e sem
`clientId`. Abrir um modelo com um cliente cria uma peça nova substituindo
`logo.imageUrl` e o bloco `footer` pelos dados do cliente. Modelos são da
conta (userId).

GC: imagens de fundo enviadas viram asset `piece_background`, referenciado
por `mc_pieces.document`; o `uploads-gc` ganha essa consulta. Fotos de produto
são da galeria (fora do GC do commercials). O `piece_still` segue a regra do
`commercial_composed` (90 dias, 3 por projeto).

### 7. Rotas e contratos

Formato novo `offer_piece` (entra em `MC_PROJECT_FORMATS`, `RENDER_FORMATS`,
`getConfig`, `MC_FORMATS`); preflight = ffmpeg + ffprobe + fontes + navegador.

| Rota | Corpo / resposta | Regras |
| --- | --- | --- |
| `POST /commercials/pieces` | `{ clientId, aspectRatio, templateId? }` → peça com logo e rodapé do cliente | 422 `FORMAT_NOT_ENABLED` |
| `GET /commercials/pieces?kind=` | lista (peças ou modelos) | |
| `GET /commercials/pieces/:id` | peça | 404/403 |
| `PATCH /commercials/pieces/:id` | `{ document, expectedRevision }` (autosave) | 409 revisão; 422 `PIECE_INVALID` com `issues[]` por bloco |
| `POST /commercials/pieces/:id/save-as-template` | `{ name }` → modelo | |
| `POST /commercials/pieces/:id/still` | prévia 1080p pelo worker (opcional; a prévia do editor já é fiel) | fila `mc.render` |
| `POST /commercials/projects/from-piece` | `{ pieceId, kitId, tier?, channel?, captionsEnabled?, musicEnabled? }` → projeto `offer_piece` em `scripting` | mesmas gates do F1/F2 + `KIT_TILE_MISSING` na criação (hoje só na aprovação) |
| `PATCH /commercials/projects/:id/piece` | `{ document, expectedRevision }` depois do roteiro | campos falados → reescreve a frase e volta a `storyboard_review`; só visuais → `assembly_only` |
| existentes | `GET projects/:id`, `PATCH script`, `prepare`, `quote`, `approve-production`, `scenes/:id/reroll`, `scenes/:id/dialogue`, `approve-assembly`, `duplicate` | `duplicate` aceita `aspectRatio` e re-layouta a peça |

Diretor do `offer_piece`: o do F2 (`buildDirectorSystemPromptF2`) com as
ofertas = `items` com `spoken: true` na ordem da peça, `storeName` do cliente
e a validade do rodapé disponível para o fechamento. Cenas `talk_tile`, uma
por frase. Limites do F2 (≤ 30 s medidos, alinhamento por palavra só se
legendas ligadas).

### Auto-layout (função pura, no pacote compartilhado)

- Entradas: formato, `rect` da área, quantidade (2 a 12), item em destaque.
- Saída: `rect` de cada item e do selo, respeitando tamanho mínimo de texto
  no formato de saída (preço ≥ 36 px em 1080 de largura; nome ≥ 24 px).
- Distribuições fixas para 2, 3, 4, 6 e 8; 5, 7 e 9 a 12 usam a seguinte com a
  última linha centralizada. Destaque ocupa o espaço de dois.
- Vive em `@chroma/video-templates` (`layoutProducts`) para o editor e o
  servidor (duplicar formato) usarem a mesma regra. Qualquer edição manual
  marca `layout: 'manual'`; "arrumar de novo" volta a `'auto'`.

### Frontend

- Rota nova `/commercials/pieces/:id` (editor) e `/commercials/pieces/new`.
- Editor: prévia à direita (o `PieceCanvas` a tamanho natural com
  `transform: scale`), painel à esquerda com as etapas (fundo, produtos, logo
  e textos, rodapé, personagem). `react-rnd` para mover/redimensionar blocos
  com `scale`. Guias e área segura reaproveitam `safeAreaFor`.
- Estado local do descritor com autosave (debounce 1 s, `expectedRevision`),
  TanStack Query para peça, produtos (`productsService.getAll`), galeria
  (`GalleryProductPickerDialog`), cliente (logo, rodapé, lojas) e fontes
  (`fontStore`).
- "Gerar vídeo" abre o resumo (kit, tier, canal, custo do `quote`) e chama
  `from-piece`; a revisão do projeto reaproveita `CommercialProject.tsx` com um
  painel `OfferPieceReview` (storyboard = frases por produto, como o F2).

### Fases

1. **Fase 1 (lançamento)**: `mc_pieces` + editor (fundo, grade com auto-layout
   e edição livre, logo, textos, rodapé, personagem em painel liso), `render_still`,
   compose do F1, diretor do F2, 9:16 e 4:5, modelos, reroll por fala.
2. **Fase 2**: rosto do logo na peça, duplicar formato com re-layout, preço
   mudou → reescrita parcial, imagem única com produtos citados, chroma key
   (fundo transparente) após bake-off.

## Decisões técnicas (fechadas em 22/10/2026)

1. **Componente compartilhado**: `PieceCanvas` e `layoutProducts` vivem no
   pacote `@chroma/video-templates` e são consumidos pelo frontend e pelo
   worker (fecha o TODO 6.9 para este formato).
2. **Peça como entidade própria** (`mc_pieces`), com `pieceId` + `pieceSnapshot`
   no projeto.
3. **Personagem em painel liso no lançamento**; chroma key ("fundo
   transparente") na fase 2, depois do bake-off com os motores.
4. **`render_still` no worker** (Remotion `renderStill`), nunca no navegador
   do cliente.
