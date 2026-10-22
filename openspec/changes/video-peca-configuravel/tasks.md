# Tasks: peça de ofertas configurável

Ordem de trabalho. Cada grupo fecha com testes (unit no backend com jest, no
frontend com vitest; e2e mock sem chamadas pagas) e com a convenção de erro
D13: forma → 400 pelo pipe, regra de negócio → 422 `{code, message, details}`.

Decisões técnicas fechadas em 22/10/2026: componente compartilhado em
`@chroma/video-templates`; peça como entidade própria `mc_pieces`; personagem
em painel liso no lançamento (chroma na fase 2); quadro parado renderizado
no worker.

## 1. Produto e especificação

- [x] 1.1 Analisar os vídeos de referência (Nini, Piccin) e o vídeo gerado em 21/10
- [x] 1.2 Escrever a visão do cliente e a usabilidade (doc "Comercial de ofertas configurável")
- [x] 1.3 Fechar as decisões de produto (editor próprio, fotos da galeria, limites, formatos)
- [x] 1.4 Fechar as decisões técnicas (componente compartilhado, `mc_pieces`, painel liso, still no worker)
- [ ] 1.5 Revisar as specs desta change contra o `design.md` (cenários, códigos de erro `PIECE_INVALID`, `KIT_TILE_MISSING` na criação) e mover a change para `../openspec/changes/` do monorepo

## 2. Domínio da peça (backend, puro, sem IO)

- [x] 2.1 `domain/mc-piece.ts`: tipos do descritor (`McPieceDocument`, blocos `logo | text | footer | products | character`, `rect` em frações, `schemaVersion: 1`), constantes de limite (`MC_PIECE_MAX_PRODUCTS = 12`, `MC_PIECE_MAX_SPOKEN = 6`, `MC_PIECE_MAX_TEXTS = 5`, `MC_PIECE_MIN_CHARACTER_WIDTH = 0.25`, `MC_PIECE_MAX_BYTES = 2 MiB`)
- [x] 2.2 `validatePieceDocument(document, ctx)` → `issues[]` por bloco (`blockId`, `code`, `message`): blocos dentro do quadro, um personagem, produtos 2..12 com nome legível (não arquivo/EAN) e foto `/uploads/`, `spoken` ≤ 6, textos ≤ 5, fonte existente, personagem ≥ 25% da largura, `logo_face` só com kit `logo_as_is`
- [x] 2.3 `pieceCanonicalHash(document)` (JSON canônico, mesma função de `input-hash.ts`) e `pieceSpokenOffers(document)` → `McSealProduct[]` na ordem da peça (ponte para o diretor do F2)
- [x] 2.4 `applyClientToPiece(document, client)` (logo e rodapé do cliente) e `templateFromPiece(document)` (remove `items`, `clientId`)
- [x] 2.5 `pieceChangeScope(before, after)` → `'spoken' | 'visual' | 'none'` (nome/preço de item `spoken` muda a fala; o resto é só composição), espelhando a regra do `PATCH /composition` do F2
- [x] 2.6 Specs: `mc-piece.spec.ts` cobrindo limites, hash estável por ordem de chaves e `pieceChangeScope`

## 3. Pacote compartilhado `@chroma/video-templates`

- [ ] 3.1 `layoutProducts({ aspect, areaRect, count, featuredId })` → `rect` por item e por selo; distribuições 2/3/4/6/8 e regra das demais; tamanhos mínimos de texto (preço ≥ 36 px, nome ≥ 24 px a 1080 de largura); testes com números fixados por formato
- [ ] 3.2 Componente `PieceCanvas({ document, width, height, assetBase })`: fundo (sólido, degradê, imagem com fit/blur/darken), blocos por `zIndex`, selo de preço de/por, rodapé faixa/pill, painel do personagem com o poster do tile; sem estado interno
- [ ] 3.3 Fontes: `@font-face` a partir de `document.fonts[]` (família + URL absoluta) com `delayRender`/`continueRender` no Remotion e carregamento normal no navegador
- [ ] 3.4 Composição Remotion `OfferPieceStill` (um quadro) e `parsePieceDocument` (zod) exportados do `dist/cjs/core`; `COMPOSITION_VERSION` incrementada
- [ ] 3.5 Publicar o pacote (ou fixar o checkout em `MC_VIDEO_TEMPLATES_DIR` também para o frontend via workspace) — a decisão de distribuição fica registrada no README do pacote
- [ ] 3.6 Fixture: um descritor completo de exemplo (`fixtures/piece-9x16.json`) usado pelos testes do pacote, do backend e do frontend

## 4. Backend: entidade e rotas da peça

- [x] 4.1 Migration `CreateMcPieces`: tabela `mc_pieces` (id, userId, clientId nullable, kind `piece|template`, name, aspectRatio, document jsonb, revision, createdAt, updatedAt) + índice `(userId, kind, updatedAt)`; `mc_projects.pieceId` uuid nullable e `pieceSnapshot` jsonb; `up`/`down` testados com run/revert
- [x] 4.2 Entidade `McPiece` + `McPiecesService` (`services/mc-pieces.service.ts`): criar (com `applyClientToPiece`), listar, obter, `PATCH` com `expectedRevision` (409 `REVISION_CONFLICT`), `save-as-template`, apagar (422 se há projeto não terminal apontando para ela)
- [x] 4.3 DTOs com `@ValidateNested`/`@Type` por tipo de bloco (o pipe global tem `forbidNonWhitelisted`); teto de 2 MiB → 422 `PIECE_TOO_LARGE`; `imageUrl` só `/uploads/` (como `ProjectProductDto`)
- [x] 4.4 Rotas no `commercials.controller.ts`: `POST/GET pieces`, `GET/PATCH/DELETE pieces/:id`, `POST pieces/:id/save-as-template`; guard `McEnabledGuard` + JWT; dono por `userId`
- [x] 4.5 Formato `offer_piece`: `MC_PROJECT_FORMATS`, `RENDER_FORMATS` (ffmpeg, ffprobe, fontes, navegador), `getConfig`, token em `MC_FORMATS`, `FORMAT_NOT_ENABLED`
- [x] 4.6 Specs: `mc-pieces.service.spec.ts` (CRUD, revisão, modelo, dono) e `commercials.controller.pieces.spec.ts` (forma dos DTOs, 400 em chave desconhecida)

## 5. Backend: projeto a partir da peça

- [ ] 5.1 `POST projects/from-piece` (`services/mc-from-piece.service.ts`): gates na ordem do F1/F2 (pausa, formato, v2, preflight, kit aprovado e **com tile**, peça válida e do usuário) → projeto `offer_piece` com `pieceId`, `pieceSnapshot` (cópia), `aspectRatio` da peça, `options.products` = `pieceSpokenOffers`, `logoBox` = rect do bloco `character` quando `logo_face`
- [ ] 5.2 Step `SCRIPT` do `offer_piece`: diretor do F2 (`buildDirectorSystemPromptF2`) com as ofertas faladas na ordem da peça, `storeName` do cliente e validade do rodapé no contexto; `buildOfferCarouselScript` com `format: 'offer_piece'`; mock determinístico igual ao F2
- [ ] 5.3 `McScript` do `offer_piece`: `window` = rect do bloco `character` (em frações do quadro de saída, já que a peça tem o tamanho de saída), `logoFace`, `talkBackgroundColor` = cor do painel; `validateScriptV2` aceita o formato
- [ ] 5.4 `PATCH projects/:id/piece` `{ document, expectedRevision }`: `pieceChangeScope` → `spoken`: reescreve a frase do item pelo line builder do F2 e segue `updateScript` (volta a `storyboard_review`); `visual`: revisão `assembly_only` (render_still + compose + finalize); atualiza `pieceSnapshot`
- [ ] 5.5 `duplicate` com `aspectRatio` diferente: clona a peça, roda `layoutProducts` do pacote no servidor, cria projeto novo em `storyboard_review` com os TTS clonados como `skipped_cached` (mesmo caminho de `duplicateProject`)
- [ ] 5.6 Specs: criação (gates, snapshot, ofertas faladas), roteiro mock (abertura + N + fechamento ≤ 30 s), `PATCH piece` nos dois escopos, duplicação

## 6. Backend: render do quadro e composição

- [ ] 6.1 Step de projeto `RENDER_STILL` (`McStepType`, fila `mc.render`, concorrência 1): hash = `pieceCanonicalHash` + `COMPOSITION_VERSION` + versões das fontes; cache por hash (`findCachedOutput`); produz asset `piece_still` (PNG 1080p do formato, `metadata.pieceHash`)
- [ ] 6.2 `services/mc-still-renderer.ts`: `renderStill` do Remotion com o navegador e o bundle já abertos pelo `mc-carousel-renderer` (reaproveitar `openBrowser`/bundle); URLs absolutas via `MC_RENDER_ASSET_BASE_URL`; renderizador mock (sharp: fundo + retângulos) quando `MC_PIPELINE_PROVIDER=mock`
- [ ] 6.3 Plano de execução do `offer_piece` (`mc-execution-plan.ts`): por cena `tts → talk`; por projeto `render_still → compose_ffmpeg → finalize`; `compose` espera o still e todas as cenas prontas
- [ ] 6.4 `compose_ffmpeg` com `backgroundArt = piece_still`: sem `fill`/pad (o still já é 1080p do formato); janela = rect do personagem; painel liso = cor do bloco (`talkBackgroundColor`); modo `logo_face` = caminho atual com cor do entorno amostrada do still
- [ ] 6.5 Hash do compose inclui o `pieceHash` do still; mudar só a fala não re-renderiza o still, mudar só a peça não regrava falas
- [ ] 6.6 GC: asset `piece_background` (upload de fundo) referenciado por `mc_pieces.document`; `piece_still` com a regra do `commercial_composed`; consulta de referências em `uploads-gc.rules.ts`
- [ ] 6.7 Quote e créditos: `render_still` custa 0 crédito (como o render); `quote` do `offer_piece` lista tts/talk por frase como o F2
- [ ] 6.8 Specs: hash do still estável, plano de execução, compose com still (ffmpeg real sobre fixture 1080×1920), GC

## 7. Frontend: editor da peça

- [ ] 7.1 Rotas `/commercials/pieces/new` e `/commercials/pieces/:id`; serviço `commercialsPiecesService` (criar, obter, `PATCH` com `expectedRevision`, listar modelos, salvar como modelo, `from-piece`); tipos espelhando o pacote
- [ ] 7.2 Tela: painel de etapas à esquerda (Fundo, Produtos, Logo e textos, Rodapé, Personagem), prévia à direita com `PieceCanvas` do pacote em tamanho natural e `transform: scale`; formato e cliente no topo
- [ ] 7.3 Fundo: cor (paleta + seletor), degradê (duas cores + ângulo), imagem (galeria ou upload → `piece_background`) com fit, blur e escurecimento
- [ ] 7.4 Produtos: busca em `productsService.getAll`, foto por `GalleryProductPickerDialog` (obrigatória), edição de nome/gramatura/preço de/por/unidade na peça, marcação `spoken` (até 6), `layoutProducts` automático a cada mudança, "arrumar de novo"
- [ ] 7.5 Edição livre com `react-rnd` (`scale`): mover/redimensionar qualquer bloco, reordenar produtos por arrasto (`layout: 'manual'`), destaque, estilo do selo, fundo da área; guias e área segura com `safeAreaFor`
- [ ] 7.6 Logo (do cliente, `ClientLogoPicker`), textos soltos (até 5, fontes do `fontStore`), rodapé (dados do cliente, faixa/pill, validade)
- [ ] 7.7 Personagem: kit aprovado com tile (`KIT_TILE_MISSING` explicado), modo `in_piece` com painel (card/círculo/cor) ou `logo_face` (só kit de logo); silhueta do tile na prévia; mínimo de 25% travado
- [ ] 7.8 Autosave (debounce 1 s, `expectedRevision`, 409 → recarrega e avisa), `issues[]` do `PIECE_INVALID` apontando o bloco; salvar como modelo; abrir modelo com cliente
- [ ] 7.9 "Gerar vídeo": resumo (kit, tier, canal, legendas, trilha, custo do `quote`) → `from-piece` → navega para o projeto
- [ ] 7.10 Testes: lógica pura com `*.test.ts` (autosave, escopo de mudança, issues por bloco); componentes com `renderToStaticMarkup` como `offerCarouselComponents.test.tsx`

## 8. Frontend: revisão e entrega do projeto

- [ ] 8.1 `CommercialProject.tsx`: ramo `offer_piece` com `useOfferPieceProject` (mesma forma dos hooks do F1/F2) e `OfferPieceStoryboard` (frases por produto, editar/ouvir, abertura e fechamento), `OfferPieceReviewPanel` (prévia = still + clipes), ações `refazer` e `duplicar_como_economico`
- [ ] 8.2 "Editar a peça" depois do roteiro → `PATCH projects/:id/piece` com o escopo explicado ao usuário (vai regravar a fala do produto X / só recompõe)
- [ ] 8.3 Duplicar em 4:5 (abre a peça re-layoutada para ajuste antes de gerar); legendas e trilha como opções antes da produção
- [ ] 8.4 Banner "preço mudou no catálogo" para itens com `catalogId` (reaproveita `CatalogChangedBanner`)

## 9. Qualidade e operação

- [ ] 9.1 e2e mock `e2e-piece.mjs` na stack `docker-compose.e2e.yml`: criar peça, 4 produtos, personagem, `from-piece`, roteiro, prepare, aprovar, still mock, compose, entrega; sem chamadas pagas
- [ ] 9.2 Teste de fidelidade: still renderizado pelo worker × captura do `PieceCanvas` no navegador da e2e, diferença média de pixels abaixo de um limiar fixado
- [ ] 9.3 Preflight do worker para `offer_piece` (navegador + fontes) refletido em `/v1/health` e no `getConfig`; `.env.example` e CLAUDE.md atualizados (`MC_FORMATS=offer_piece`, `MC_VIDEO_TEMPLATES_DIR`)
- [ ] 9.4 Vídeo real com o cliente de referência (kit realista) em 9:16 e 4:5, revisão lado a lado com o Piccin; bake-off de chroma key com os três motores registrado em `docs/evidence` (entrada da fase 2)
