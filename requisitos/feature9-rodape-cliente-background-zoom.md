# Feature 9 — Rodapé do Cliente: Background com Imagem, Dimensões ao Vivo e Zoom

> **Status:** ✅ implementado (etapa aprovada pelo cliente).
> **Escopo:** 100% frontend. Sem mudanças de backend, de tipos ou de modelo de dados.
> **Verificação:** `tsc --noEmit`, `eslint`, `vitest` (22 testes, +2 para a fábrica de fundo) e
> `npm run build` — todos verdes. Verificação interativa no browser pendente (precisa da stack
> rodando: backend :3001 + `npm run dev`).
>
> **Ajuste pós-feedback:** o popover "Fundo" (modos CSS de imagem) foi **removido** por ser
> redundante e de efeito invisível quando há um elemento de imagem cobrindo o rodapé. O fundo
> agora se divide em: **cor/transparência** pelo formulário (agora aplicadas ao vivo, mesmo após
> edição manual) e **imagem** pelo botão "Usar imagem como fundo" (elemento com transformação
> livre + objectFit Conter/Preencher/Esticar e opacidade no inspetor).

## Visão Geral

Evolução do **editor do rodapé do cliente** (modal acessível em `/clients` → ícone de rodapé).
Hoje o editor já gera um rodapé a partir dos dados do cliente e permite arrastar/redimensionar
blocos de texto e imagens, mas a manipulação do **fundo** é limitada, a **mudança de dimensões
não reflete** na modal para rodapés já salvos, e não há **zoom** — o usuário não tem noção real
do tamanho dos elementos.

Esta feature entrega três melhorias:

1. **Fundo com imagem totalmente manipulável** — upload direto, modos de preenchimento
   (Cobrir / Conter / **Esticar** / Original), posição, opacidade e cor de sobreposição
   **e também** transformação livre (arrastar/redimensionar/esticar) da imagem de fundo.
2. **Dimensões refletindo ao vivo** — alterar largura/altura (cm) atualiza o canvas
   imediatamente, em qualquer estado do rodapé.
3. **Zoom** — controle de zoom com viewport rolável, para inspecionar os elementos no tamanho real.

A IA **não** está envolvida nesta feature.

---

## Contexto — Estado Atual

Componentes em `frontend/src/components/clients/footer/`:

| Arquivo | Papel |
|---------|-------|
| `ClientFooterDialog.tsx` | Modal orquestradora (options ↔ section, regenerar, salvar) |
| `ClientFooterEditor.tsx` | Canvas com `react-rnd`, controles de fundo, adicionar texto/imagem |
| `ClientFooterForm.tsx` | Form gerador (layout, campos, cores, **dimensões**) |
| `ClientFooterElementProperties.tsx` | Inspetor do elemento selecionado |
| `ClientFooterPreview.tsx` | Render isolado (espelha o render aplicado) |

Utils/tipos relacionados:
- `frontend/src/utils/clientFooter.ts` — gerador `buildClientFooterSection` + `rescaleSectionToDimensions`.
- `frontend/src/utils/clientFooterElements.ts` — fábricas de elementos + `clampElementToSection`.
- `frontend/src/types/template.ts` — `TemplateSection`, `CanvasBackground`, `ImageElement`/`TextElement`.

### O que já existe

- **Imagem de fundo + upload direto** já funcionam (`uploadsService.upload(file, 'templates')`),
  mas escondidos no popover "Fundo" com apenas **Cobrir/Conter**.
- O tipo `CanvasBackground` **já suporta** `imageSize` (incl. `'100% 100%'` = esticar),
  `imagePosition`, `imageOpacity`, `imageOverlayColor` — **mas não estão expostos na UI**.

### Problemas a corrigir

- **Inconsistência de render:** existem **3 cópias** da função background→CSS. As versões
  "aplicadas" (`ClientFooterPreview.tsx`, `flyer-builder-v2/template/TemplateBackdropV2.tsx`)
  renderizam opacidade + overlay; o **editor** (`ClientFooterEditor.tsx` → `bgStyle`) **ignora**
  opacidade/overlay → o editor mostra algo diferente do resultado final.
- **Dimensões não refletem:** os inputs de Largura/Altura ficam no form recolhível e só aplicam
  quando `!manuallyEdited`. Um rodapé salvo abre com `manuallyEdited = true`, então mudar W/H
  **não faz nada visível**.
- **Sem zoom:** o editor só calcula `scale = larguraDoContainer / W` (fit na largura).

---

## Decisões de Produto (definidas com o cliente)

- **Manipulação do fundo:** *os dois* — modos CSS rápidos **e** transformação livre.
- **Ao mudar largura/altura:** *manter tamanho fixo dos elementos* — só muda a área do canvas;
  reposiciona (clamp) apenas o que sair dos limites. **Sem** reescala proporcional.
- **Origem da imagem de fundo:** *só upload direto* (sem seletor de galeria), porém mais visível.

---

## Regras de Negócio

- O editor do rodapé continua sendo aberto a partir de `/clients` e salvo como `TemplateSection`
  em `client.footer` (sem mudança no contrato de persistência).
- **Fundo (modos CSS):** ao escolher "Imagem", o usuário pode definir:
  - **Ajuste:** Cobrir (`cover`), Conter (`contain`), **Esticar** (`100% 100%`, pode deformar) e
    Original (`auto`).
  - **Posição:** 9 pontos (cima/centro/baixo × esquerda/centro/direita).
  - **Opacidade:** 0–100%.
  - **Sobreposição (overlay):** cor aplicada por cima da imagem (útil p/ legibilidade do texto).
- **Fundo livre:** botão **"Usar imagem como fundo"** faz upload e insere a imagem como um
  elemento que **cobre a seção inteira e fica atrás de tudo**. A partir daí o usuário **arrasta,
  redimensiona e estica** com as alças já existentes (e ajusta no painel de propriedades).
- **Esticar imagem (elemento):** o painel de propriedades de imagem passa a oferecer
  **Conter / Preencher / Esticar** (objectFit `contain` / `cover` / `fill`).
- **Dimensões ao vivo:** alterar Largura/Altura (cm) reflete **imediatamente** no canvas:
  - Se o layout ainda é auto-gerado (não editado manualmente) → **regenera** o layout para
    re-encaixar nas novas dimensões.
  - Se já foi editado manualmente → **mantém o tamanho** dos elementos; apenas redimensiona a
    área e reposiciona (clamp) o que sair dos limites.
- **Zoom:** controle com `−` / `%` / `+` e botão **"Ajustar"** (faixa 25%–400%). Em zoom alto, o
  canvas rola dentro de um viewport com altura limitada. 100% = tamanho 1:1 em preview-px
  (`cmToPreviewPixels`, 72 DPI), dando **noção real de proporção** (um rodapé de 8 cm aparece
  visivelmente mais alto que um de 4 cm).
- **Consistência:** o que aparece no editor (fundo com esticar/opacidade/overlay) deve ser
  **idêntico** ao rodapé renderizado no encarte/template (via `TemplateBackdropV2`) e no
  `ClientFooterPreview`.

---

## Plano Técnico de Implementação

### 1. Helper único de background — **NOVO** `frontend/src/utils/templateBackground.ts`

Extrair `backgroundToCss(bg: CanvasBackground): CSSProperties` a partir da versão completa já
existente em `ClientFooterPreview.tsx` / `TemplateBackdropV2.tsx` (que já trata
`cover/contain/100% 100%/auto`, `imagePosition`, `imageOpacity` e `imageOverlayColor` via o
truque do `linear-gradient` de overlay). Substituir as **3 cópias** por essa função:
- `ClientFooterEditor.tsx` (remove `bgStyle` local → passa a renderizar opacidade/overlay/esticar).
- `ClientFooterPreview.tsx` (remove `getBackgroundStyle` local).
- `flyer-builder-v2/template/TemplateBackdropV2.tsx` (remove `getBackgroundStyle` local).

Refator preserva o comportamento dos dois últimos e **corrige** o editor.

### 2. `ClientFooterEditor.tsx`

- **Popover "Fundo" enriquecido:** ao escolher Imagem, expor Ajuste (Cobrir/Conter/**Esticar**/
  Original), Posição (9 pontos), Opacidade (slider) e Sobreposição (color input). Todos já são
  campos de `CanvasBackground` — sem mudança de tipo.
- **Botão "Usar imagem como fundo":** upload via `uploadsService.upload(file, 'templates')` →
  insere `ImageElement` cobrindo a seção (x:0, y:0, w:`W`, h:`H`) com `zIndex 0` (todos os sites
  ordenam por `zIndex` asc → renderiza atrás). Reaproveita toda a máquina de elementos → render
  idêntico em editor/preview/encarte, sem novos campos.
- **Zoom:** estado `zoom` (%) com `scale = zoom/100`; inicializa no valor de "fit"
  (`(larguraDoContainer / W) * 100`); botão "Ajustar" recalcula o fit. Envolver o *stage* num
  viewport rolável (`overflow-auto`, altura máx. ~`55vh`), centralizado. Passar `scale` a cada
  `<Rnd scale={scale}>` (mantém o mapeamento do ponteiro).
- **Dimensões (cm) sempre visíveis:** inputs de Largura/Altura na barra do editor (junto do
  zoom), disparando novo prop `onDimensionsChange(w, h)`.

### 3. `ClientFooterDialog.tsx`

- Novo `handleDimensionsChange(widthCm, heightCm)` passado ao editor:
  - Se `!manuallyEdited` → `setSection(buildClientFooterSection(source, { ...options, widthCm, heightCm }))`.
  - Se `manuallyEdited` → `setSection({ ...section, widthCm, heightCm, elements: elements.map(el => clampElementToSection(el, novaSecao)) })` (mantém tamanho).
  - Em ambos: sincroniza `options.widthCm/heightCm` sem forçar regeneração.
- Corrige o bug: a mudança de dimensão **sempre** reflete na modal.

### 4. `ClientFooterForm.tsx`

- Remover a grade de Largura/Altura de "Aparência" (vira controle de 1ª classe sempre visível no
  editor). Form mantém layout/campos/cores.

### 5. `ClientFooterElementProperties.tsx`

- Adicionar **`fill` (Esticar)** às opções de `objectFit` da imagem (hoje só `contain`/`cover`),
  para a imagem-de-fundo poder deformar/preencher. `fill` já é válido em `ImageElement.objectFit`.

### 6. `frontend/src/utils/clientFooterElements.ts`

- Nova fábrica `createFooterBackgroundImageElement(section, src)` — imagem cobrindo a seção,
  `zIndex: 0`, `objectFit: 'cover'`, `opacity: 1`.

### Arquivos afetados

| Arquivo | Mudança |
|---|---|
| `frontend/src/utils/templateBackground.ts` | **NOVO** — helper `backgroundToCss()` |
| `frontend/src/components/clients/footer/ClientFooterEditor.tsx` | helper; fundo enriquecido; "usar como fundo"; zoom; barra de dimensões |
| `frontend/src/components/clients/footer/ClientFooterDialog.tsx` | `handleDimensionsChange` (regenera vs clamp por `manuallyEdited`) |
| `frontend/src/components/clients/footer/ClientFooterForm.tsx` | remove inputs de W/H |
| `frontend/src/components/clients/footer/ClientFooterElementProperties.tsx` | objectFit `fill` (Esticar) |
| `frontend/src/utils/clientFooterElements.ts` | `createFooterBackgroundImageElement()` |
| `frontend/src/components/clients/footer/ClientFooterPreview.tsx` | usa helper compartilhado |
| `frontend/src/components/flyer-builder-v2/template/TemplateBackdropV2.tsx` | usa helper compartilhado |

---

## Verificação

1. **Lint/Types/Build:** `npm run lint` e `npm run build` (frontend).
2. **Testes:** `npm test` (vitest) — manter `clientFooter.test.ts` verde; adicionar teste rápido
   para `createFooterBackgroundImageElement` (cobre a seção, `zIndex 0`).
3. **Manual** (`npm run dev`, `/clients` → ícone do rodapé):
   - **Fundo CSS:** definir imagem, alternar Cobrir/Conter/**Esticar**/Original, mudar posição,
     opacidade e overlay → editor agora mostra opacidade/overlay e bate com o `ClientFooterPreview`.
   - **Fundo livre:** "Usar imagem como fundo" → imagem entra atrás dos textos; arrastar,
     redimensionar e esticar (`objectFit: fill`).
   - **Dimensões:** abrir um rodapé **salvo**, mudar Largura/Altura → canvas redimensiona e
     elementos mantêm o tamanho (só clampam se saírem); em rodapé novo, o layout gerado re-encaixa.
   - **Zoom:** `−`/`+`/"Ajustar"; em zoom alto o viewport rola; arrastar elemento continua preciso.
   - **Consistência aplicada:** salvar e conferir o rodapé via `TemplateBackdropV2` no
     FlyerBuilderV2 — fundo idêntico ao editor.
