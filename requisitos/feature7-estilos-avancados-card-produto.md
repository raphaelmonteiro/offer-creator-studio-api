# Feature 7 — Estilos Avancados de Card de Produto no Editor de Encartes

## Visao Geral

Evolucao do sistema de renderizacao e customizacao dos cards de produto no editor de encartes, permitindo replicar layouts profissionais de supermercados (ex: encartes estilo Pacheco, Guanabara, Assai). O objetivo e dar ao usuario controle granular sobre a aparencia de cada card de produto para atingir resultados visuais que hoje nao sao possiveis.

---

## Contexto — Estado Atual

### O que ja existe

| Recurso | Opcoes atuais |
|---------|---------------|
| Layout do card | `image-top`, `image-bottom`, `image-left`, `image-right` |
| Imagem como fundo | Toggle on/off (overlay escuro sobre a imagem) |
| Cor de fundo do card | Paleta CMYK com cor solida |
| Borda do card | Espessura (sem borda, fina, media, grossa) + cor |
| Bordas arredondadas | Nenhum, pequeno, medio, grande, circular |
| Estilo de preco | `box` (quadrado), `rounded` (arredondado), `minimal` (sem fundo), `badge` (destaque) |
| Mostrar unidade | Toggle on/off |
| Mostrar preco original (de/por) | Toggle on/off |
| Tipografia por elemento | Tamanho (8 niveis), cor, fonte, peso, estilo, espacamento, transformacao |
| Secoes com cor de fundo | Cor + opacidade (0-100%) + full section toggle |
| ColSpan/RowSpan | Apenas por secao, nao por produto |
| Gap entre cards | Fixo (`gap-0.5` para 5+ colunas, `gap-1` para menos) |

### O que falta para replicar encartes profissionais

Encartes reais de supermercados (referencia: Pacheco Supermercado) possuem caracteristicas visuais que o sistema atual nao atende:

1. **Cards invisiveis** — produtos flutuam direto sobre a cor da secao, sem fundo ou borda propria no card
2. **Preco estilo splash/explosao** — o classico starburst vermelho com R$ pequeno, valor grande e centavos em sobrescrito
3. **Separacao visual das partes do preco** — R$, parte inteira e centavos com tamanhos independentes
4. **Tamanhos variaveis por produto** — dentro da mesma secao, alguns produtos maiores que outros
5. **Controle de espacamento** — gap entre cards ajustavel (inclusive zero)
6. **Posicao do preco sobre a imagem** — preco "colado" no canto da imagem, nao em bloco separado

---

## Sub-features

### 7.1 — Novos Estilos de Preco (Fase 1)

**Prioridade: Alta** | **Impacto visual: Alto** | **Complexidade: Media**

#### Descricao

Adicionar novos estilos de exibicao de preco alem dos 4 existentes, focados no visual classico de supermercados.

#### Novos estilos

| Estilo | Descricao visual | Referencia |
|--------|-----------------|------------|
| `splash` | Starburst/explosao — estrela irregular com cor de fundo e preco centralizado | Classico de encartes brasileiros (ex: Pacheco, Guanabara) |
| `circle` | Circulo solido com preco dentro | Comum em encartes minimalistas |
| `tag` | Formato de etiqueta de preco (retangulo com triangulo recortado num canto) | Etiquetas de gondola |
| `diagonal` | Faixa diagonal colorida cruzando o canto do card | Comum em encartes modernos |

#### Implementacao

- Adicionar os novos valores ao tipo `PriceStyleType` em `src/types/editor.ts`
- Implementar a renderizacao de cada estilo em `ProductCard.tsx`:
  - `splash`: SVG de starburst como container do preco (8-12 pontas, cor configuravel)
  - `circle`: `div` com `border-radius: 50%`, largura/altura iguais
  - `tag`: CSS clip-path ou pseudo-elemento para o recorte
  - `diagonal`: `transform: rotate(-15deg)` com overflow hidden no card
- Adicionar opcoes ao seletor de estilo de preco em `SettingsPanel.tsx`
- Cada estilo deve respeitar as cores do tema (`priceStyle.backgroundColor`, cores do tema)

#### Regras de negocio

- O estilo de preco e uma configuracao **global do encarte** (aplicado a todos os cards), via `cardSettings.priceStyle`
- Os estilos novos devem funcionar com todos os layouts de card existentes
- O splash e o circle devem ter tamanho proporcional ao tamanho do card (adaptar ao size class: lg/md/sm/xs/xxs)

---

### 7.2 — Separacao Visual do Preco (Inteiro / Centavos / Simbolo)

**Prioridade: Alta** | **Impacto visual: Alto** | **Complexidade: Media**

#### Descricao

Renderizar o preco dividido em 3 partes visuais independentes com tamanhos diferentes:

```
 R$        ← simbolo (pequeno)
  2        ← parte inteira (grande)
   ,99     ← centavos (medio, sobrescrito)
```

#### Implementacao

- Criar funcao `parsePrice(price: number)` que retorna `{ symbol: 'R$', integer: string, cents: string }`
  - Ex: `parsePrice(2.99)` → `{ symbol: 'R$', integer: '2', cents: ',99' }`
  - Tratar caso de preco inteiro: `parsePrice(12)` → `{ symbol: 'R$', integer: '12', cents: ',00' }`
- Alterar a renderizacao do preco em `ProductCard.tsx` para usar 3 `<span>` com classes separadas:
  - Simbolo: ~40% do tamanho base do preco
  - Inteiro: 100% do tamanho base (o maior)
  - Centavos: ~55% do tamanho base, com `vertical-align: super` ou `align-self: flex-start`
- Manter o preco como `display: inline-flex` com `align-items: baseline` para alinhamento correto

#### Configuracao

Adicionar ao `CardSettings`:

```typescript
priceDisplay: 'unified' | 'split';  // default: 'unified' (comportamento atual)
```

- `'unified'` — renderiza como texto unico (R$ 2,99) — comportamento atual, sem quebra
- `'split'` — renderiza separado com tamanhos diferentes

#### Regras de negocio

- A separacao e uma opcao global do encarte (nao por produto)
- Deve funcionar combinada com todos os estilos de preco (box, rounded, splash, etc.)
- Quando o estilo e `splash` ou `circle`, o preco separado fica dentro do shape

---

### 7.3 — Card Transparente (Sem Fundo)

**Prioridade: Alta** | **Impacto visual: Alto** | **Complexidade: Baixa**

#### Descricao

Permitir que o card de produto nao tenha fundo nem borda proprios, fazendo o produto "flutuar" diretamente sobre a cor de fundo da secao.

#### Implementacao

Adicionar ao seletor de cor de fundo do card a opcao `'transparent'`:

```typescript
// Em CardSettings
backgroundColor: string; // Existente — adicionar 'transparent' como valor especial
```

- Quando `backgroundColor === 'transparent'`:
  - Nao renderizar fundo no card
  - Nao renderizar borda (independente da config de borda)
  - Nao renderizar sombra
  - Nao renderizar border-radius
- Adicionar um botao/icone "sem fundo" no seletor de cores do `SettingsPanel.tsx` (icone de proibido ou transparencia)
- O card transparente depende de a secao ter `backgroundFullSection: true` e `backgroundOpacity: 100` para o efeito visual funcionar como no Pacheco

#### Regras de negocio

- Configuracao global do encarte (todos os cards)
- Quando transparente, a area clicavel do card continua existindo (para selecao, drag-drop)
- Os textos (nome, preco, unidade) devem manter contraste — considerar adicionar um leve text-shadow automatico quando card e transparente

---

### 7.4 — Controle de Gap entre Cards

**Prioridade: Media** | **Impacto visual: Medio** | **Complexidade: Baixa**

#### Descricao

Permitir ao usuario ajustar o espacamento (gap) entre os cards de produto dentro do grid.

#### Implementacao

Adicionar ao `CardSettings`:

```typescript
gap: 'none' | 'tight' | 'normal' | 'relaxed';  // default: 'normal'
```

Mapeamento para CSS:

| Valor | CSS class | Pixels aprox |
|-------|-----------|-------------|
| `none` | `gap-0` | 0px |
| `tight` | `gap-px` | 1px |
| `normal` | `gap-1` | 4px (comportamento atual) |
| `relaxed` | `gap-2` | 8px |

- Aplicar o gap no `CanvasEditor.tsx` onde hoje e fixo (`gap-0.5` / `gap-1`)
- Adicionar seletor no `SettingsPanel.tsx` na secao "Card de Produto"

#### Regras de negocio

- Configuracao global do encarte
- O gap `none` combinado com card transparente replica o estilo denso do Pacheco

---

### 7.5 — ColSpan/RowSpan por Produto

**Prioridade: Media** | **Impacto visual: Medio** | **Complexidade: Alta**

#### Descricao

Permitir que produtos individuais ocupem mais de 1 celula do grid, tanto em colunas (colSpan) quanto em linhas (rowSpan). Isso permite destacar produtos especificos (ex: melancia grande, oferta principal).

#### Implementacao

Adicionar ao tipo `Product`:

```typescript
colSpan?: number;  // default: 1 — quantas colunas o produto ocupa
rowSpan?: number;  // default: 1 — quantas linhas o produto ocupa
```

- Em `CanvasEditor.tsx`, ao renderizar produtos dentro de uma secao, aplicar `gridColumn: span ${colSpan}` e `gridRow: span ${rowSpan}` no container do card
- O `ProductCard.tsx` nao muda — ele ja se adapta ao tamanho do container
- No `ProductForm.tsx` (sidebar de edicao do produto), adicionar campos opcionais:
  - "Colunas" — input numerico (1 a max colunas da secao)
  - "Linhas" — input numerico (1 a max linhas da secao)
  - Mostrar apenas quando o grid tem mais de 1 coluna

#### Regras de negocio

- Configuracao **por produto** (nao global)
- `colSpan` nao pode exceder o numero de colunas da secao
- `rowSpan` nao pode exceder o numero de linhas disponiveis
- Quando um produto tem span > 1, os slots ocupados por ele nao recebem outros produtos
- O calculo de `getMaxProducts()` deve considerar os spans — um produto 2x2 ocupa 4 slots
- Produtos com span > 1 devem manter a proporcao visual (imagem maior, preco maior proporcionalmente)

#### Complexidade tecnica

Esta e a sub-feature mais complexa porque afeta o algoritmo de layout em `useGridLayout.ts` e `CanvasEditor.tsx`. O grid CSS nativo suporta `span`, mas o algoritmo que distribui produtos nas celulas precisa ser adaptado para "reservar" celulas quando um produto tem span > 1.

---

### 7.6 — Posicao do Preco no Card

**Prioridade: Baixa** | **Impacto visual: Medio** | **Complexidade: Media**

#### Descricao

Permitir controlar onde o bloco de preco aparece dentro do card, incluindo opcoes de overlay sobre a imagem.

#### Implementacao

Adicionar ao `CardSettings`:

```typescript
pricePosition: 'default' | 'over-image-top-right' | 'over-image-top-left' | 'over-image-bottom-right' | 'over-image-bottom-left' | 'inline-right';
```

| Posicao | Descricao |
|---------|-----------|
| `default` | Comportamento atual — preco no bloco de informacoes abaixo/ao lado da imagem |
| `over-image-*` | Preco posicionado como overlay sobre a imagem do produto (position: absolute) |
| `inline-right` | Preco alinhado a direita na mesma linha do nome |

- Quando `pricePosition` e `over-image-*`:
  - O container do preco recebe `position: absolute` + posicao correspondente
  - O container da imagem recebe `position: relative`
  - O preco fica sobre a imagem com z-index superior
  - Funciona especialmente bem com estilos `splash`, `circle` e `badge`

#### Regras de negocio

- Configuracao global do encarte
- `over-image-*` so funciona quando o card tem imagem; sem imagem, volta para `default`
- Combina com todos os estilos de preco

---

## Ordem de Implementacao Recomendada

```
Fase 1 (visual de supermercado completo):
  7.1 — Novos estilos de preco (splash, circle, tag, diagonal)
  7.2 — Separacao visual do preco (split)
  7.3 — Card transparente
  7.4 — Controle de gap

Fase 2 (posicionamento):
  7.6 — Posicao do preco no card

Fase 3 (layout avancado):
  7.5 — ColSpan/RowSpan por produto
```

A Fase 1 sozinha ja permite replicar ~90% do visual de encartes profissionais como o Pacheco, combinando splash de preco + preco split + card transparente + gap zero + secoes com fundo opaco. O splash e o elemento visual mais iconico dos encartes de supermercado e deve ser implementado junto com as demais sub-features da Fase 1.

---

## Arquivos Impactados

| Arquivo | Sub-features | Tipo de alteracao |
|---------|-------------|-------------------|
| `src/types/editor.ts` | 7.1, 7.2, 7.3, 7.4, 7.5, 7.6 | Adicionar tipos e campos |
| `src/components/editor/ProductCard.tsx` | 7.1, 7.2, 7.3, 7.6 | Renderizacao dos novos estilos |
| `src/components/editor/CanvasEditor.tsx` | 7.4, 7.5 | Gap e grid com spans |
| `src/components/editor/SettingsPanel.tsx` | 7.1, 7.2, 7.3, 7.4, 7.6 | Novos controles na sidebar |
| `src/components/editor/ProductForm.tsx` | 7.5 | Campos colSpan/rowSpan |
| `src/hooks/useGridLayout.ts` | 7.5 | Algoritmo de layout com spans |
| `src/services/flyerConfigService.ts` | 7.2, 7.4, 7.5 | Serializacao dos novos campos |

---

## Compatibilidade

- Todos os novos campos possuem valores default que preservam o comportamento atual
- Encartes existentes (salvos antes dessa feature) continuam renderizando identicamente
- A migracao e transparente — campos ausentes usam defaults:
  - `priceDisplay`: `'unified'`
  - `gap`: `'normal'`
  - `pricePosition`: `'default'`
  - `Product.colSpan`: `1`
  - `Product.rowSpan`: `1`
  - `backgroundColor: 'transparent'` e um valor novo, nao afeta cards existentes que ja tem cor
