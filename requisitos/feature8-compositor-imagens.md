# Compositor de Imagens (Multi-Image Composer)

## Contexto

Hoje, cada card de produto no encarte tem **uma única imagem**. Mas é comum o cliente
querer mostrar **várias variações do mesmo produto em uma só foto** (ex.: linha de sabonetes
com 3 fragrâncias, kit de molhos, doces variados — como na referência em anexo do encarte
Adobe Express).

O cliente precisa de um editor leve onde possa:
1. Escolher o formato do canvas (1:1, 4:3, 3:4, 16:9, 9:16 ou livre em px).
2. Adicionar N imagens (upload novo ou da galeria existente).
3. Posicionar livremente (mover/redimensionar/rotacionar/z-order) e opcionalmente remover
   o fundo de cada imagem via IA.
4. Nomear a composição e salvar.

O resultado é **um PNG salvo na galeria** (e no bucket de uploads). Quando aberto **a partir
do card de produto no editor**, o PNG gerado **substitui automaticamente** a imagem do produto
naquele encarte. Quando aberto **a partir de `/gallery`**, apenas salva.

## Pontos de entrada

1. **Editor de encarte (FlyerBuilderV2)** — botão "Criar composição" no painel/controles do
   card de produto, ao lado do botão atual que abre o `GalleryPickerDialog`. Ao salvar, o
   URL retornado vira a `productImage` do elemento selecionado.
   - Arquivo afetado: [ProductCardStyleControlsV2.tsx](frontend/src/components/flyer-builder-v2/product-card/ProductCardStyleControlsV2.tsx)
2. **Página da galeria (`/gallery`)** — botão "Nova composição" no header. Ao salvar, só
   atualiza a lista.
   - Arquivo afetado: [Gallery.tsx](frontend/src/pages/Gallery.tsx) (página atual de galeria)

Ambos abrem o **mesmo componente** `MultiImageComposerDialog` com prop `onSaved(url)` —
a diferença é só o que o caller faz com o URL.

## Arquitetura

**Tudo client-side**, sem rotas novas no backend. Reutiliza:
- `galleryService.upload(files, folderId?)` ([galleryService.ts](frontend/src/services/api/galleryService.ts)) para persistir o PNG final.
- `html-to-image` (`toPng`) para rasterizar o DOM do canvas em PNG — mesmo padrão de
  [thumbnailGenerator.ts](frontend/src/utils/thumbnailGenerator.ts).
- `react-rnd` para drag/resize de cada imagem — mesmo padrão de
  [CanvasElementItem.tsx](frontend/src/components/template-builder/CanvasElementItem.tsx).
- `GalleryPickerDialog` ([shared/GalleryPickerDialog.tsx](frontend/src/components/shared/GalleryPickerDialog.tsx)) para "adicionar da galeria".
- `cmykColors` ([constants/cmykColors.ts](frontend/src/constants/cmykColors.ts)) para o seletor de cor de fundo.
- **(Opcional) remover fundo via IA** — chamar endpoint Replicate SAM já existente no módulo
  `ai` do backend; se hoje não há rota pública para "remove background" isolado, expor um
  wrapper fino reutilizando o mesmo serviço (validar na implementação — pode ser que o SAM
  esteja embutido em outro flow). Se não houver wrapper barato, deixar este recurso atrás de
  uma feature-flag e marcar como follow-up.

## UI

Componente novo: `frontend/src/components/composer/MultiImageComposerDialog.tsx` + subcomponentes
em `frontend/src/components/composer/`.

Estrutura do dialog (shadcn `<Dialog>` em largura ~1100px, padrão de
[ImageCropTemplateDialog.tsx](frontend/src/components/template-builder/ImageCropTemplateDialog.tsx)):

```
┌─ Header: "Compositor de imagens" + input "Nome da composição" ──────────┐
│                                                                          │
│ ┌─ Toolbar esquerda ─┐  ┌─ Canvas (área central) ───────┐  ┌─ Camadas ─┐ │
│ │ Formato:           │  │                                │  │ Lista de  │ │
│ │  [1:1][4:3][3:4]   │  │   (DOM rasterizado por         │  │ imagens   │ │
│ │  [16:9][9:16][Livre]│ │    html-to-image, com Rnd      │  │ com z-    │ │
│ │ Largura/Altura px  │  │    para cada imagem)           │  │ order +   │ │
│ │ Fundo: [transp.|⬛] │  │                                │  │ visibility│ │
│ │ + Adicionar:       │  │                                │  │           │ │
│ │  [Upload][Galeria] │  │                                │  │           │ │
│ └────────────────────┘  └───────────────────────────────┘  └──────────┘ │
│                                                                          │
│ Item selecionado: [Rotacionar][Remover fundo IA][↑Frente][↓Trás][🗑]    │
│                                                  [Cancelar] [Salvar]    │
└──────────────────────────────────────────────────────────────────────────┘
```

Estado local (Zustand store leve ou `useState` + `useReducer`):
```ts
type ComposerState = {
  name: string;
  aspectPreset: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | 'custom';
  width: number;   // px — usado para o canvas DOM E para o pixelRatio do toPng
  height: number;
  background: { kind: 'transparent' } | { kind: 'solid'; color: string };
  items: Array<{
    id: string;
    src: string;            // blob: URL local (upload) ou URL da galeria
    naturalWidth: number;
    naturalHeight: number;
    x: number; y: number; w: number; h: number;
    rotation: number;       // graus
    zIndex: number;
    isProcessing?: boolean; // durante remove-bg
  }>;
  selectedItemId: string | null;
};
```

## Fluxo de save

1. Validar: `name` não vazio, ≥1 imagem no canvas.
2. Ocultar handles/seleção (toggle ref).
3. `toPng(canvasRef.current, { pixelRatio: 2, backgroundColor: undefined })` → dataURL.
4. `fetch(dataURL).then(r => r.blob())` → criar `File` com `name + '.png'`.
5. `galleryService.upload([file])` → recebe `GalleryImage[]` com `.url`.
6. Chamar `onSaved(galleryImage)` — caller decide o que fazer:
   - **Editor**: atualiza `productImage` do elemento via store
     (`useFlyerBuilderV2Store.updateProductImage` / `selectProductImage` — verificar nome
     exato no momento da implementação em
     [useFlyerBuilderV2Store](frontend/src/store/)).
   - **Galeria**: refetch da lista.
7. Fechar dialog + toast.

## Arquivos a modificar/criar

**Novos:**
- `frontend/src/components/composer/MultiImageComposerDialog.tsx` — dialog principal.
- `frontend/src/components/composer/ComposerCanvas.tsx` — canvas rasterizável + Rnd items.
- `frontend/src/components/composer/ComposerToolbar.tsx` — formato/fundo/adicionar.
- `frontend/src/components/composer/ComposerLayersPanel.tsx` — lista de camadas/z-order.
- `frontend/src/components/composer/composerState.ts` — reducer/store leve.
- `frontend/src/utils/composer/exportComposition.ts` — helper `canvasEl → File` (usa
  `html-to-image` + util de dataURL→File, possivelmente extraído do
  `thumbnailGenerator.ts`).

**Modificados:**
- `frontend/src/components/flyer-builder-v2/product-card/ProductCardStyleControlsV2.tsx`
  — adicionar botão "Criar composição" ao lado do trigger do `GalleryPickerDialog`;
  no `onSaved` chamar a mesma ação que hoje troca a imagem do produto.
- `frontend/src/pages/Gallery.tsx` (ou equivalente) — botão "Nova composição" no header
  que abre o dialog com `onSaved` apenas invalidando a query/refetch da lista.

**Backend:** nada de novo é necessário para o MVP. Apenas validar que o limite de upload
(`MAX_FILE_SIZE`) acomoda PNGs de até ~5–10 MB; se não, ajustar `.env`/`fileUploadOptions`.

**Pendência a confirmar na implementação:** existência de endpoint reutilizável para "remover
fundo" isoladamente. Se não houver, expor um endpoint fino `POST /v1/ai/remove-background`
no módulo `ai/` que aceita uma URL de imagem (já em `/uploads/...`) e retorna URL nova com
fundo removido — reutilizando o serviço Replicate SAM. **Listar como sub-task; não bloqueia o
MVP do compositor** (basta esconder o botão se a flag/endpoint não existir).

## Verificação (manual)

1. `docker compose up` (postgres + backend + frontend).
2. **Fluxo editor**:
   - Login → abrir um encarte existente → selecionar um card de produto → clicar
     "Criar composição".
   - Selecionar 4:3, upload de 3 imagens, mover/redimensionar/rotacionar, mandar uma para
     trás, remover fundo de uma (se disponível), nomear "Kit teste".
   - Salvar → confirmar que a imagem do produto no canvas trocou pelo PNG gerado.
   - Em `/gallery`, confirmar que "Kit teste.png" aparece.
3. **Fluxo galeria**: em `/gallery` → "Nova composição" → repetir; confirmar que aparece
   na lista e que **não** alterou nenhum produto.
4. **Edge cases**:
   - Salvar com nome vazio → mostra erro inline, não fecha.
   - Salvar com 0 imagens → erro.
   - Trocar formato com imagens posicionadas → mantém posições (em coordenadas px), só
     muda dimensões do canvas; aceitar que imagens podem ficar fora da nova área.
   - Fundo transparente → PNG exportado deve ter alpha 0 fora das imagens (validar abrindo
     no Preview/qualquer viewer).
5. **Print/export do encarte**: exportar o flyer após substituição e conferir que o PNG
   composto sai com qualidade nítida (pixelRatio 2 deve resolver).

## Fora de escopo (follow-ups)

- Filtros/ajustes por imagem (brilho, saturação, sombra).
- Templates/layouts pré-prontos (grid 2×2, grid 3×1 etc.).
- Edição posterior da composição (hoje será "destrutivo" — salva PNG; reabrir não restaura
  as camadas). Para isso seria preciso persistir o JSON de estado junto na galeria.
- Busca Pixabay como fonte adicional dentro do compositor (foi recusada no scoping).
