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

> Repo do pacote: `raphaelmonteiro/video-templates` (branch `claude/affectionate-bohr-2u3siq`, versão 0.2.0). O
> frontend importa `@chroma/video-templates/piece` (React puro) e o backend `@chroma/video-templates/core`;
> as cópias provisórias (`offer-creator-studio/src/lib/video-templates/piece/`, `domain/mc-piece-layout.ts`)
> foram apagadas. Quadro real verificado: `npm run still:piece` com a fixture renderizou 1080×1920 pelo Remotion.

- [x] 3.1 `layoutProducts({ areaRect, width, height, itemIds, featuredId })` → rect por item (frações do quadro), colunas por quantidade (1/2/2+1 ou 3/2×2/3/4), destaque em duas colunas, última linha incompleta centralizada, folga de 2%, mínimos de texto (preço ≥ 36 px, nome ≥ 24 px a 1080); testes com números fixados (`test/piece-layout.test.ts`) — em `src/core/piece/layout.ts` do pacote
- [x] 3.2 `PieceCanvas({ document, width, height, assetBase | resolveAssetUrl, imgComponent, characterPosterUrl })`: fundo (sólido, degradê, imagem como `<img>` com fit/blur/darken), blocos por `zIndex`, selo de/por com unidade, rodapé faixa/pill, painel do personagem com o poster do tile, `@font-face` das fontes da conta, célula em destaque (larga) com a foto à esquerda; sem estado e sem Remotion (`src/components/piece/PieceCanvas.tsx`, entrada `./piece`; teste com `renderToStaticMarkup`)
- [x] 3.3 Fontes: `@font-face` injetado pelo canvas (navegador) e, na composição, `loadFont` de cada `fonts[i]` sob `delayRender`/`continueRender` (`usePieceFontsReady`); fonte indisponível segue com o fallback
- [x] 3.4 Composição Remotion `OfferPieceStill` (Still de um quadro, `Img` do Remotion, `staticFile` para fixtures, `calculateMetadata` valida as props) e `parsePieceDocument`/`parseOfferPieceStillProps` (zod) exportados de `dist/cjs/core`; `COMPOSITION_VERSION` 0.2.0; a raiz registra só a composição que as input props pedem (uma por bundle)
- [x] 3.5 Distribuição decidida e registrada no README do pacote: privado, sem registro; dependência git fixada (`github:raphaelmonteiro/video-templates#<tag|sha>`) com `dist/` versionado; tag `vX.Y.Z` = `package.json#version` quando o branch chegar em `main` (backend e frontend fixam o commit `8be1eca` até lá); `MC_VIDEO_TEMPLATES_DIR` segue opcional no worker
- [x] 3.6 Fixture `fixtures/piece-9x16.json` (props completas: 6 produtos com destaque, logo, texto, rodapé, personagem) usada pelos testes do pacote, pelo Studio, pelo backend (`mc-piece-package.spec.ts`: válida pelas regras do backend com fotos em `/uploads/`) e pelo frontend (`pieceEditor.test.ts`)

## 4. Backend: entidade e rotas da peça

- [x] 4.1 Migration `CreateMcPieces`: tabela `mc_pieces` (id, userId, clientId nullable, kind `piece|template`, name, aspectRatio, document jsonb, revision, createdAt, updatedAt) + índice `(userId, kind, updatedAt)`; `mc_projects.pieceId` uuid nullable e `pieceSnapshot` jsonb; `up`/`down` testados com run/revert
- [x] 4.2 Entidade `McPiece` + `McPiecesService` (`services/mc-pieces.service.ts`): criar (com `applyClientToPiece`), listar, obter, `PATCH` com `expectedRevision` (409 `REVISION_CONFLICT`), `save-as-template`, apagar (422 se há projeto não terminal apontando para ela)
- [x] 4.3 DTOs com `@ValidateNested`/`@Type` por tipo de bloco (o pipe global tem `forbidNonWhitelisted`); teto de 2 MiB → 422 `PIECE_TOO_LARGE`; `imageUrl` só `/uploads/` (como `ProjectProductDto`)
- [x] 4.4 Rotas no `commercials.controller.ts`: `POST/GET pieces`, `GET/PATCH/DELETE pieces/:id`, `POST pieces/:id/save-as-template`; guard `McEnabledGuard` + JWT; dono por `userId`
- [x] 4.5 Formato `offer_piece`: `MC_PROJECT_FORMATS`, `RENDER_FORMATS` (ffmpeg, ffprobe, fontes, navegador), `getConfig`, token em `MC_FORMATS`, `FORMAT_NOT_ENABLED`
- [x] 4.6 Specs: `mc-pieces.service.spec.ts` (CRUD, revisão, modelo, dono) e `commercials.controller.pieces.spec.ts` (forma dos DTOs, 400 em chave desconhecida)

## 5. Backend: projeto a partir da peça

- [x] 5.1 `POST projects/from-piece` (`services/mc-from-piece.service.ts`): gates na ordem do F1/F2 (pausa, formato, v2, preflight, kit aprovado e **com tile**, peça válida e do usuário) → projeto `offer_piece` com `pieceId`, `pieceSnapshot` (cópia), `aspectRatio` da peça, `options.products` = `pieceSpokenOffers`, `logoBox` = rect do bloco `character` quando `logo_face`
- [x] 5.2 Step `SCRIPT` do `offer_piece`: diretor do F2 (`buildDirectorSystemPromptF2`) com as ofertas faladas na ordem da peça, `storeName` do cliente e validade do rodapé no contexto; `buildOfferCarouselScript` com `format: 'offer_piece'`; mock determinístico igual ao F2
- [x] 5.3 `McScript` do `offer_piece`: `window` = rect do bloco `character` (em frações do quadro de saída, já que a peça tem o tamanho de saída), `logoFace`, `talkBackgroundColor` = cor do painel; `validateScriptV2` aceita o formato
- [x] 5.4 `PATCH projects/:id/piece` `{ document, expectedRevision }` (`services/mc-piece-project.service.ts`, `mc-piece-project.controller.ts`): `pieceChangeScope` → `spoken` (ou cor do painel/modo do personagem, que estão nos clipes): reescreve só as frases dos itens afetados pelo line builder do F2 (cenas das ofertas intactas preservam identidade e dialogue; falado novo = cena nova; falado removido = cena fora) e segue `updateScript` (volta a `storyboard_review`, `rewrittenLines` na resposta); `visual` depois da entrega: `updateComposition` abre `assembly_only` (render_still + compose + finalize) com o `pieceHash` como mudança; `visual` antes da entrega: `updatePieceInPlace` grava no lugar sem revisão nova. `pieceSnapshot`, `logoBox` e `options.products` acompanham na mesma transação. Recusas: `PIECE_ASPECT_MISMATCH`/`PIECE_KIT_CHANGED` (duplique), `NO_PIECE_CHANGE`, `PIECE_INVALID`, `FORMAT_NOT_OFFER_PIECE`, 409 `REVISION_CONFLICT`. Efeito colateral corrigido: `isCompositionOnlyChange` deixou de tratar `talkBackgroundColor` como composição (a cor está nos clipes — o F1 passava para `assembly_only` com clipes da cor antiga)
- [ ] 5.5 `duplicate` com `aspectRatio` diferente: clona a peça, roda `layoutProducts` do pacote no servidor, cria projeto novo em `storyboard_review` com os TTS clonados como `skipped_cached` (mesmo caminho de `duplicateProject`) — depende do `layoutProducts` do pacote (grupo 3)
- [ ] 5.6 Specs: criação (gates, snapshot, ofertas faladas) ✔, roteiro mock e openai ✔, `PATCH piece` nos dois escopos e recusas ✔ (`mc-quality.piece.spec.ts`, `mc-script-v2.talk-color.spec.ts`); falta a duplicação (com 5.5)

## 6. Backend: render do quadro e composição

- [x] 6.1 Step de projeto `RENDER_STILL` (`McStepType`, fila `mc.render`, concorrência 1): hash = `pieceCanonicalHash` + aspecto + `COMPOSITION_VERSION` + renderizador + fontes da conta (`computeRenderStillHash`); reaproveitamento por hash do mesmo usuário com arquivo presente (`reusableStill`, como o render do F2); produz asset `piece_still` (PNG do formato em `/final/v{n}/still.png`, `metadata.pieceHash`) — `processors/mc-render-still.processor.ts`
- [x] 6.2 `services/mc-still-renderer.ts`: `RemotionStillRenderer` usa `runtime()` do `RemotionCarouselRenderer` (módulos, bundle e navegador já abertos; composição `OfferPieceStill`, `MC_OFFER_PIECE_STILL_COMPOSITION_ID`; composição ausente → `RENDER_UNAVAILABLE`); props em URL absoluta (`buildOfferPieceStillProps`, `domain/mc-piece-still-props.ts`); `MockStillRenderer` em sharp (fundo sólido/degradê/imagem + um desenho por bloco, `buildMockStillPlan`) com o pipeline mock
- [x] 6.3 Plano de execução do `offer_piece`: `render_still → compose_ffmpeg → finalize`; `render_still` é independente das cenas (`isSceneIndependentProjectStep`): o scheduler o libera assim que pendente, o `compose` espera o quadro E todas as cenas; a fase `assembling` começa no primeiro step que precisa das cenas (`firstSceneDependentAssemblyStep`); quadro falhado ainda em `generating` pausa de lá e a retomada (`approve-assembly`) rearma a cadeia e devolve à produção se faltam cenas. Pendência no front: `stageForStepType('render_still') = 'assembly'` (grupo 8)
- [x] 6.4 `compose_ffmpeg` com `backgroundArt = piece_still` da MESMA cadeia (`stillAssetIdFor`, mesmo attempt; 422 interna `piece_still_missing` sem ele): o quadro já tem o tamanho de saída (contain-fit e pad são identidade); janela = rect do personagem (roteiro); cor = painel do bloco (`talkBackgroundColor`); `logo_face` = caminho do F1 com a caixa confirmada do projeto — a cor do entorno é a do painel (gravada em `surroundColor` na criação a partir da peça), não amostrada do still: na peça o painel liso É o entorno do logo
- [x] 6.5 Hash do compose inclui o `pieceHash` (só quando presente — os composes do F1 ficam como estão); matriz provada em `mc-materializer-piece.spec.ts`: só a fala muda ⇒ quadro igual; só a peça muda ⇒ quadro e compose novos, TTS/talk intactos
- [x] 6.6 GC: kinds `piece_still` (regra das entregas: 3 mais recentes por projeto, 90 dias) e `piece_background` (30 dias sem URL em `mc_pieces.document` nem em `mc_projects.pieceSnapshot` → `piece_background_unreferenced`; sem a consulta de referências, preserva); consulta em `uploads-gc.service.ts`. O upload que cria `piece_background` vem com o editor (7.3)
- [x] 6.7 Quote e créditos: `render_still` custa 0 (`MC_STEP_CREDITS`); `quotePhase` do `offer_piece` lista talk por fala + `render_still` + compose + finalize (mesma conta do F2)
- [x] 6.8 Specs: `mc-step-hashes.piece.spec.ts`, `mc-scheduler-piece.spec.ts`, `mc-piece-still-props.spec.ts`, `mc-still-renderer.spec.ts` (sharp real + runtime Remotion falso), `mc-render-still.processor.spec.ts`, `mc-materializer-piece.spec.ts`, caso `offer_piece` em `mc-compose-ffmpeg.processor.spec.ts`, GC em `commercials-gc.rules.spec.ts`, e `mc-piece-still-compose.fixture.spec.ts` (ffmpeg real, `MC_TEST_FFMPEG=1`: quadro 1080×1920 do mock como arte, PSNR ≥ 40 dB fora da janela, clipe no rect do personagem)

## 7. Frontend: editor da peça

> Grupos 3 e 7 — onde o código vive: `layoutProducts`, `PieceCanvas` e os tipos do descritor vivem no pacote
> `@chroma/video-templates` (entrada `./piece`, React puro); o frontend os importa de lá e a casa provisória
> `src/lib/video-templates/piece/` foi apagada (grupo 3 concluído).

- [x] 7.1 Rotas `/commercials/pieces/new` e `/commercials/pieces/:id` (`?projectId=` abre a peça congelada de um vídeo); serviço `commercialsPiecesService` (criar, obter, `PATCH` com `expectedRevision`, listar modelos, salvar como modelo, upload de fundo, `from-piece`, `PATCH projects/:id/piece`); tipos do descritor importados de `@chroma/video-templates/piece`
- [x] 7.2 Tela `CommercialPieceEditor`: etapas à esquerda (Fundo, Produtos, Logo e textos, Rodapé, Personagem), prévia à direita (`PieceStage`: `PieceCanvas` em tamanho natural + `transform: scale`, zoom/ajustar); nome, formato e estado do autosave no topo
- [x] 7.3 Fundo (`BackgroundPanel`): cor (paleta curta de vídeo + seletor), degradê (duas cores + ângulo), imagem (galeria ou upload → `POST pieces/backgrounds` = `piece_background`) com fit, desfoque e escurecimento
- [x] 7.4 Produtos (`ProductsPanel`): catálogo (busca em `productsService.getAll`; produto sem foto pede a foto na galeria) ou galeria (`GalleryProductPickerDialog`), edição de nome/gramatura/preço de/por/unidade, fala (até 6, pelo menos 1), destaque, ordem, grade/imagem única, estilo da área e do selo, "arrumar de novo"
- [x] 7.5 Edição livre com `react-rnd` (`scale`): camada de alças sobre o canvas — blocos e cada produto da grade (arrastar um produto congela `layout: 'manual'`); `clampRect` mantém no quadro e trava o personagem em 25%; guias da área segura (`safeAreaFor`)
- [x] 7.6 Logo (do cliente por `clientsService.getById` ou da galeria), textos soltos (até 5, fontes do `fontStore` → `document.fonts`), rodapé (faixa/pill, endereço, telefone, validade, legal, cores)
- [x] 7.7 Personagem (`CharacterPanel`): kits aprovados (sem tile desabilitados e explicados), modo `in_piece` com painel card/círculo/cor ou `logo_face` só com kit `logo_as_is`; tile como poster no painel da prévia
- [x] 7.8 Autosave (`usePieceEditor`: debounce 1 s, `expectedRevision`, 409 → recarrega e avisa, 422 → toast), `issues[]` por bloco com atalho para a etapa (`PieceIssuesList`); salvar como modelo; nova peça a partir de modelo (`CommercialPieceNew`)
- [x] 7.9 "Gerar vídeo" (`GeneratePieceVideoDialog`): título, qualidade, canal, legendas, trilha → `from-piece` → projeto; bloqueio pelo `GET /config` (formato/render) e pelas pendências; `PIECE_INVALID`/`KIT_TILE_MISSING` explicados. (O custo do `quote` fica na tela do projeto — não há projeto antes do `from-piece`.)
- [~] 7.10 Testes: `layoutProducts.test.ts` (números fixados), `PieceCanvas.test.tsx` (renderToStaticMarkup), `pieceEditor.test.ts` (mutações, limites, escopos), `pieceProject.test.ts`; falta cobrir o hook de autosave e os painéis com render estático

## 8. Frontend: revisão e entrega do projeto

- [x] 8.1 `CommercialProject.tsx`: ramo `offer_piece` reaproveitando `useOfferCarouselProject` (o roteiro tem a forma do F2); `OfferPieceStoryboard` (uma fala por produto falado + abertura/fechamento, prévia do quadro, "Editar a peça"; ordem/produtos mudam pela peça), `OfferPieceReviewPanel` (vozes medidas, alternativas, bloqueios inline, prévia do quadro); remontagem `assembly_only` pelo `AssemblyReviewPanel` genérico; pós-entrega com `TalkingArtDeliveredActions` (ajustar texto, regravar fala) + "Editar a peça"
- [x] 8.2 "Editar a peça" → editor com `?projectId=` (peça congelada do vídeo, sem autosave) → "Aplicar no vídeo" = `PATCH projects/:id/piece`; o `pieceChange` da resposta vira o aviso (`describePieceChange`: "N falas foram reescritas" / "Só o quadro muda" / regrava pela cor do painel); `PIECE_INVALID` volta como pendências, `PIECE_ASPECT_MISMATCH`/`PIECE_KIT_CHANGED` explicam que é outro vídeo
- [ ] 8.3 Duplicar em 4:5 (abre a peça re-layoutada para ajuste antes de gerar); legendas e trilha como opções antes da produção
- [ ] 8.4 Banner "preço mudou no catálogo" para itens com `catalogId` (reaproveita `CatalogChangedBanner`)

## 9. Qualidade e operação

- [ ] 9.1 e2e mock `e2e-piece.mjs` na stack `docker-compose.e2e.yml`: criar peça, 4 produtos, personagem, `from-piece`, roteiro, prepare, aprovar, still mock, compose, entrega; sem chamadas pagas
- [ ] 9.2 Teste de fidelidade: still renderizado pelo worker × captura do `PieceCanvas` no navegador da e2e, diferença média de pixels abaixo de um limiar fixado
- [x] 9.3 Preflight do worker para `offer_piece` (ffmpeg, ffprobe, fontes, navegador) em `RENDER_REQUIREMENTS`, refletido em `/v1/health` (`worker.render.formats.offer_piece`) e no `getConfig`; `.env.example` (`MC_FORMATS` admite `offer_piece`) e CLAUDE.md (formato, rotas, `render_still`, preflight) atualizados
- [ ] 9.4 Vídeo real com o cliente de referência (kit realista) em 9:16 e 4:5, revisão lado a lado com o Piccin; bake-off de chroma key com os três motores registrado em `docs/evidence` (entrada da fase 2)
