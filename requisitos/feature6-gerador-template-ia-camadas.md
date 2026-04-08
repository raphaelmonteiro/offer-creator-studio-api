# Feature 6 — Editor de Template em Camadas com IA

## Visão Geral

Extensão natural da Feature 5. O usuário passa pelo mesmo fluxo de geração com IA, mas ao escolher o **modo Camadas**, em vez de receber uma imagem flat para recortar, recebe o template já decomposto em camadas separadas — cada elemento como um PNG independente com fundo transparente. Após a geração, o usuário entra em um editor de camadas estilo Photoshop leve, onde pode manipular cada elemento individualmente antes de salvar.

**Pré-requisito:** Feature 5 implementada e em produção. ✓

---

## Dois Modos de Geração

O passo "Gerar com IA" (step 3 da tela atual) ganha um toggle visível acima do chat:

```
[ ⚡ Imagem Rápida ]   [ ✨ Camadas Editáveis ]
```

| | Imagem Rápida (F5 atual) | Camadas Editáveis (F6 novo) |
|---|---|---|
| O que a IA gera | 1 imagem flat | 1 background + N PNGs transparentes |
| Próximo passo | Recorte (crop) | Editor de camadas |
| Editabilidade | Nenhuma (imagem estática) | Total — cada elemento é independente |
| Velocidade | ~10s | ~30–60s (múltiplas gerações paralelas) |
| Custo de API | 1 chamada | 2–5 chamadas paralelas |
| Ideal para | Templates rápidos, fundos simples | Templates ricos, datas comemorativas, quando o usuário quer refinar |

O modo selecionado persiste durante a sessão. O chat e o prompt funcionam igual nos dois modos — o que muda é o que acontece depois de enviar.

---

## Fluxo Completo — Modo Camadas

```
1. /templates → "Gerar com IA" → AiTemplateGeneratorDialog (nome + formato)
2. Estilo → escolhe preset ou preenche form personalizado  (igual F5)
3. Gerar com IA → toggle "Camadas Editáveis" selecionado
4. Usuário descreve o template no chat e envia
5. IA gera em paralelo:
   - Background (imagem de fundo, sem elementos)
   - Elemento 1 (PNG transparente)
   - Elemento 2 (PNG transparente)
   - ...até 4 elementos
6. Tela muda para o Editor de Camadas
7. Usuário edita à vontade (ver seção abaixo)
8. Clica "Salvar Template"
9. Sistema salva o FlyerTemplate com ImageElements reais
10. Redireciona para /templates
```

---

## O que a IA Gera (Composição)

A IA retorna uma estrutura de composição com:

**Background:** Uma imagem de textura/padrão adequada para o tema. Sem elementos decorativos — só fundo. Fica como `imageBackground` da seção header.

**Elementos decorativos (máx. 4):** Cada um é um PNG com fundo transparente. Exemplos:
- Natal: árvore pequena, bolas natalinas, flocos de neve, faixa de neve
- Páscoa: coelho, ovos coloridos, flores, pingos de chocolate
- Carnes: chamas, picanha grelhada, brasa
- Hortifruti: cesto de frutas, folhas, fatia de melancia

Cada elemento vem com uma posição e tamanho sugeridos pela IA, que o código converte em coordenadas reais de canvas.

**Body background:** Nunca uma imagem gerada — sempre uma cor sólida ou gradiente suave derivado da paleta. Os cards de produto precisam de legibilidade.

**Footer background:** Cor sólida escura da paleta da IA.

---

## Editor de Camadas — Tela

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  TOOLBAR: Modo | Zoom | Desfazer | Refazer | Salvar         │
├───────────────┬─────────────────────────────┬───────────────┤
│               │                             │               │
│  PAINEL DE    │      CANVAS CENTRAL         │  PAINEL DE    │
│  CAMADAS      │   (preview em tamanho       │  PROPRIEDADES │
│               │    proporcional)            │               │
│  Lista de     │                             │  Controles do │
│  todas as     │  Header                     │  elemento     │
│  camadas      │  ┌─────────────────────┐    │  selecionado  │
│  em ordem     │  │ bg + elementos      │    │               │
│  visual       │  └─────────────────────┘    │               │
│               │  Body                       │               │
│               │  ┌─────────────────────┐    │               │
│               │  │ cor sólida          │    │               │
│               │  └─────────────────────┘    │               │
│               │  Footer                     │               │
│               │  ┌─────────────────────┐    │               │
│               │  │ cor sólida          │    │               │
│               │  └─────────────────────┘    │               │
│               │                             │               │
└───────────────┴─────────────────────────────┴───────────────┘
```

### Painel de Camadas (esquerda)

Lista vertical de todas as camadas, de cima para baixo na ordem de renderização:

```
HEADER
  □ 👁 🔒  Elemento: Árvore de Natal      [IA] [×]
  □ 👁 🔒  Elemento: Bolas natalinas      [IA] [×]
  □ 👁 🔒  Fundo: textura neve            [IA] [×]
BODY
  □ 👁 🔒  Fundo: vermelho sólido         [cor]
FOOTER
  □ 👁 🔒  Fundo: verde-escuro sólido     [cor]
```

Controles por camada:
- **👁 Olho** — mostra/oculta a camada no canvas
- **🔒 Cadeado** — trava/destrava (travar impede seleção acidental)
- **Arrastar** — reordena camadas dentro da mesma seção (drag-and-drop vertical)
- **[×]** — remove a camada
- **[IA]** — badge indicando que foi gerado por IA (clicável para regenerar)
- **Clique na linha** — seleciona a camada e exibe suas propriedades no painel direito

### Canvas Central

- Exibe o template inteiro (header + body + footer) em tamanho proporcional à tela
- Linhas divisórias entre header/body/footer sempre visíveis
- Elementos clicáveis: clicou = selecionado (borda de seleção + handles)
- **Handles de resize** nos 4 cantos e nos 4 lados
- **Arrastar** para reposicionar livremente dentro da seção
- **Duplo clique num elemento de imagem** → abre opção de substituir
- **Ctrl+Z / Cmd+Z** — desfazer (stack de 20 estados)
- **Delete / Backspace** — remove elemento selecionado

### Painel de Propriedades (direita)

Conteúdo varia conforme o tipo de camada selecionada:

---

#### Quando nenhuma camada está selecionada — Painel Global

- Nome do template
- Formato (read-only, definido no passo 1)
- Altura do header (slider em cm)
- Altura do footer (slider em cm)
- Cor do body (color picker)
- Cor do footer (color picker)

---

#### Elemento de Imagem (PNG decorativo gerado pela IA)

```
POSIÇÃO E TAMANHO
  X: [___] px    Y: [___] px
  W: [___] px    H: [___] px
  🔗 Manter proporção (toggle)

TRANSFORMAÇÃO
  Rotação: [___]°  (slider -180 a 180)
  Opacidade: [___]% (slider 0–100)
  Espelhar: [H] [V] (botões)

AJUSTES DE IMAGEM
  Brilho:    [slider -100 a 100]
  Contraste: [slider -100 a 100]
  Saturação: [slider -100 a 100]

AÇÕES
  [🔄 Regenerar com IA]       → abre prompt pré-preenchido, regera só esse elemento
  [📁 Substituir por arquivo] → upload manual de PNG
  [🖼 Substituir da galeria]  → escolhe da galeria de imagens
  [🗑 Remover]
```

---

#### Fundo de Seção (background de header, body ou footer)

```
TIPO DE FUNDO
  ● Cor sólida
  ○ Gradiente
  ○ Imagem

Se Cor sólida:
  Cor: [color picker]

Se Gradiente:
  Cor inicial: [picker]   Cor final: [picker]
  Ângulo: [slider 0–360°]

Se Imagem:
  [URL ou upload]
  Tamanho: [cover / contain / repeat]
  Posição: [center / top / bottom]
  Opacidade: [slider 0–100%]
  [🔄 Regenerar fundo com IA]
  [📁 Substituir por arquivo]
  [🖼 Substituir da galeria]

SOBREPOSIÇÃO DE COR (overlay)
  Cor: [picker]   Opacidade: [0–100%]
```

---

#### Adicionar Novos Elementos

Botão "+ Adicionar" no topo do painel de camadas abre menu:

```
[+ Adicionar]
  → Gerar com IA       (mini prompt: "descreva o elemento")
  → Upload de arquivo  (PNG com transparência)
  → Da galeria         (imagens salvas)
  → Texto              (adiciona TextElement)
```

Quando "Gerar com IA": o usuário digita uma descrição curta ("coelho de chocolate 3D olhando para frente"), o sistema chama a API de geração de elemento transparente e dropa no canvas posicionado no centro da seção header por padrão.

---

#### Elemento de Texto (TextElement)

```
CONTEÚDO
  [área de texto editável]

TIPOGRAFIA
  Família: [dropdown fontes disponíveis]
  Tamanho: [número]
  Peso: [Normal / Bold]
  Estilo: [Normal / Itálico]
  Cor: [color picker]
  Alinhamento: [⬅ ⬛ ➡]

POSIÇÃO E TAMANHO
  X, Y, W, H (mesmo que imagem)

EFEITOS
  Sombra: toggle + [cor] [blur] [offset X] [offset Y]
  Cor de fundo: toggle + [color picker] + [padding]
  Border radius: [slider]

TRANSFORMAÇÃO
  Rotação: [slider]
  Opacidade: [slider]
```

---

## Refinamento via IA (após geração inicial)

Um mini-chat fica colapsado na borda inferior do editor. O usuário pode abrir e pedir refinamentos sem sair do editor:

**Refinamentos que NÃO geram nova imagem (só reposicionam):**
- "Mova a árvore para a direita" → IA retorna nova posição X/Y, aplica no canvas
- "Aumente o coelho" → IA retorna novo width/height, aplica no canvas
- "Centralize os ovos" → calcula posição central da seção, aplica

**Refinamentos que geram nova imagem para 1 elemento:**
- "Troque a árvore por uma árvore de neve" → regera só aquele PNG
- "Substitua as chamas por brasa incandescente" → regera só aquele PNG

**Refinamentos que regeneram o background:**
- "Mude o fundo para textura de madeira escura" → regera só o background

**Refinamentos que regeneram tudo:**
- "Refaça o tema como Black Friday" → nova composição completa

O backend identifica o tipo de refinamento e executa só as chamadas necessárias.

---

## Integração com Template Builder

Ao clicar "Salvar Template", o sistema monta um `FlyerTemplate` com elementos reais:

```typescript
{
  header: {
    id: 'header',
    widthCm: format.printWidthCm,
    heightCm: format.headerHeightCm,
    background: { type: 'image', imageUrl: bgUrl, imageSize: 'cover', imageOpacity: 100 },
    elements: [
      { id: 'el-1', type: 'image', src: treeUrl,  x: 120, y: 10, width: 200, height: 180, zIndex: 2, objectFit: 'contain', opacity: 1 },
      { id: 'el-2', type: 'image', src: ballsUrl, x: 20,  y: 40, width: 100, height: 80,  zIndex: 1, objectFit: 'contain', opacity: 1 },
    ]
  },
  footer: {
    id: 'footer',
    widthCm: format.printWidthCm,
    heightCm: format.footerHeightCm,
    background: { type: 'solid', color: '#1a1a1a' },
    elements: []
  },
  bodyBackground: { type: 'solid', color: '#c53030' },
}
```

O template salvo é um template normal — aparece na lista de templates, pode ser aberto no template builder e editado como qualquer outro. O template builder já suporta esse formato completamente.

---

## Arquivos a Modificar / Criar

### Frontend

| Arquivo | Mudança |
|---|---|
| `src/pages/AiTemplateGenerator.tsx` | Adicionar toggle de modo (flat/camadas) no step `generate`. Adicionar novo step `layers-editor` para o modo camadas (substitui `crop` → `preview` nesse modo). |
| `src/components/template-builder/LayersEditor.tsx` | **NOVO** — editor de camadas completo: painel de camadas, canvas interativo, painel de propriedades. |
| `src/components/template-builder/LayerPanel.tsx` | **NOVO** — lista de camadas com drag-reorder, olho, cadeado, badge IA. |
| `src/components/template-builder/LayerProperties.tsx` | **NOVO** — painel de propriedades contextual (imagem / fundo / texto). |
| `src/services/api/aiService.ts` | Adicionar `generateTemplateLayers(format, messages)` → `{ layers, bodyBackground, assistantMessage }`. |

### Backend

| Arquivo | Mudança |
|---|---|
| `src/modules/ai/ai.controller.ts` | Novo endpoint `POST /v1/ai/template-layers` |
| `src/modules/ai/ai.service.ts` | Novo método `generateTemplateLayers()`: GPT-4o para composição JSON → gera background + PNGs transparentes em paralelo → upload → retorna layers com coordenadas calculadas. |
| `src/modules/ai/dto/template-layers.dto.ts` | **NOVO** — DTOs para request e response. |

---

## Decisões Técnicas

**O LayersEditor reutiliza o TemplateCanvas?**
Parcialmente. O TemplateCanvas do template builder edita 1 seção por vez. O LayersEditor mostra as 3 seções empilhadas verticalmente em escala (header + body + footer como um preview completo). Será um componente novo que importa a lógica de resize/drag/handles do TemplateCanvas.

**Histórico de desfazer (Ctrl+Z)?**
Stack simples de snapshots no React (`useState<LayerState[]>`). Cada ação que muda posição/tamanho/visibilidade/ordem empurra um snapshot na stack. Limite de 20 estados.

**Os ajustes de imagem (brilho, contraste, saturação) são client-side?**
Sim — CSS `filter` no elemento `<img>`. Não reprocessam a imagem original. Quando o template é salvo, os valores ficam como campos adicionais no `ImageElement` (`brightness`, `contrast`, `saturation`). O template builder aplica esses filtros na renderização.

**Transparência insatisfatória num elemento?**
1 retry automático silencioso. Se ainda não ficou bom, o elemento é exibido com badge amarelo "⚠ Transparência" e o usuário pode clicar para regenerar ou substituir manualmente. Não bloqueia o fluxo.

**Mover elemento via chat:**
Interpretado pelo GPT-4o (não por parsing manual). O modelo identifica qual elemento e qual nova posição, retorna só o delta — sem regerar a imagem.

---

## O que NÃO está no escopo de F6

- Ferramentas de recorte/máscara manual (remover fundo de imagens do usuário)
- Blend modes (multiply, screen, overlay, etc.)
- Efeitos avançados além de brilho/contraste/saturação/rotação
- Exportar como PSD ou arquivo em camadas
- Edição colaborativa em tempo real

---

## Critérios de Aceite

1. Toggle "Imagem Rápida / Camadas Editáveis" visível no step de geração
2. Modo Imagem Rápida continua funcionando exatamente como antes — sem regressão
3. Modo Camadas: geração retorna background + mínimo 1 PNG transparente
4. Canvas exibe composição correta com elementos sobrepostos ao fundo
5. Mover um elemento no canvas atualiza posição em tempo real
6. Redimensionar preserva proporção quando toggle ativado
7. Olho oculta/exibe camada no canvas imediatamente
8. Reordenar camadas muda a ordem de renderização (zIndex) imediatamente
9. "Regenerar com IA" regera só aquele elemento, preserva os demais
10. Salvar cria um `FlyerTemplate` com `ImageElements` reais posicionados corretamente
11. Template salvo abre no template builder sem erros
12. Ajustes de brilho/contraste/saturação refletem visualmente no canvas em tempo real
