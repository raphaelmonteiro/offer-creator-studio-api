# Feature 5 — Gerador de Template via IA (GPT-4o Image)

## Visão Geral

Substituição completa do approach atual de geração de templates via IA.

**Problema com a Feature 4 (abordagem atual):**
O GPT tentava gerar coordenadas x/y em pixels para cada elemento — uma tarefa de raciocínio espacial que LLMs fazem mal. O resultado era templates sem harmonia visual, seções desconexas e imagens aleatórias sem estilo de encarte profissional.

**Nova abordagem:**
A IA gera **uma única imagem de fundo** para o template completo (usando GPT-4o Image). O usuário refina via chat iterativo, vê o resultado em tempo real, e quando estiver satisfeito usa o **crop tool existente** (Feature 3) para dividir em header/body/footer. Textos, logo e demais elementos são adicionados depois no **template builder existente**.

---

## Por que GPT-4o Image

- **Edição iterativa com memória visual**: recebe a imagem anterior + instrução e faz modificações contextuais, sem reger do zero
- **Já integrado ao ecossistema OpenAI**: sem nova API, sem nova chave, sem nova dependência
- **Qualidade superior** para cenas complexas e estilo promocional
- **Custo**: ~$0.07/imagem. Para B2B (supermercados em assinatura) é absorvível

---

## Fluxo do Usuário

```
1. Usuário abre "Gerar Template com IA" (nova página/modal)
2. Seleciona o formato (ex: Folheto 27×54cm)
3. Descreve o template no chat (ex: "Páscoa com chocolate derretido, tons marrons e dourados")
4. Sistema gera 1 imagem de fundo proporcional ao formato selecionado
5. Usuário vê o preview da imagem gerada
6. Usuário refina via chat ("mova o coelho para a direita", "troque para tons de laranja")
7. GPT-4o Image recebe a imagem anterior + instrução → gera versão refinada
8. Repete steps 6-7 até estar satisfeito
9. Clica em "Usar este template" → abre o ImageCropTemplateDialog com a imagem gerada
10. Faz o crop definindo header/body/footer
11. É redirecionado ao template builder para adicionar textos, logo e elementos
```

---

## Princípios de Harmonia Visual

A imagem gerada é **única** — header, body e footer vêm da mesma fonte visual. O crop é apenas um recorte da imagem. Isso garante harmonia por construção, não por instrução.

No crop (Feature 3), o comportamento padrão sugerido:
- **Header**: ~25–30% do topo da imagem (região mais rica/impactante)
- **Body**: ~55–60% do meio (textura discreta, os cards de produto ficam por cima)
- **Footer**: ~10–15% da base (região mais escura, onde ficará texto de rodapé)

O usuário pode ajustar os divisores livremente, como já funciona hoje.

---

## Prompt Engineering

### Estrutura do prompt enviado ao GPT-4o Image

O sistema monta o prompt automaticamente com base no formato selecionado e na mensagem do usuário:

```
Generate a full supermarket promotional flyer background image.

Format: {largura}cm × {altura}cm (aspect ratio {w/h})
Style: vibrant Brazilian supermarket promotional flyer, bold colors, festive, professional marketing material
Theme: {mensagem do usuário traduzida/enriquecida}

Requirements:
- The image will be divided into 3 sections after generation:
  TOP ~28%: header area — most impactful, strong theme expression, rich visuals
  MIDDLE ~60%: body area — subtle texture/pattern only, will have product cards overlaid (keep it clean enough for white cards to float on top)
  BOTTOM ~12%: footer area — darker tone, suitable for small text overlay
- Do NOT include any text in the image (text will be added separately)
- Do NOT include logos or brand names
- Ensure smooth visual continuity between sections
- The body area should be a more subdued/darker version of the header theme, not a different design
```

### Refinamento iterativo

Quando o usuário pede modificações:
- A imagem atual é enviada de volta ao GPT-4o Image junto com a instrução
- O prompt de refinamento: `"Edit this image: {instrução do usuário}. Keep everything else exactly the same."`
- O sistema mantém o histórico de imagens geradas para permitir "voltar à versão anterior"

### Tradução e enriquecimento automático de prompt

O usuário escreve sempre em português. O backend usa o GPT-4o (chat) em um passo intermediário para **traduzir para inglês e enriquecer** o prompt antes de enviar ao GPT-4o Image. Isso é feito em uma única chamada — o GPT-4o retorna diretamente o prompt em inglês já enriquecido.

Motivo: modelos de geração de imagem foram treinados predominantemente em inglês. Prompts em inglês produzem resultados significativamente mais consistentes e de maior qualidade. Já fazemos o mesmo na Feature 2 (busca de imagens no Pixabay).

O sistema converte a mensagem do usuário em inglês e adiciona contexto de encarte:

| Usuário diz | Sistema enriquece para |
|---|---|
| "Páscoa com chocolate" | "Easter theme, dark melted chocolate texture, golden accents, Easter eggs, promotional flyer style" |
| "Natal vermelho e dourado" | "Christmas theme, deep red and gold, pine branches, snowflakes, festive supermarket promotional style" |
| "Black Friday" | "Black Friday theme, bold black background, yellow geometric accents, modern promotional design" |
| "Dia das Mães" | "Mother's Day theme, soft pink and white flowers, elegant, warm tones, promotional flyer" |

---

## Especificação de Tela — Frontend

### Nova página: `/template-generator` (ou modal grande)

Layout em duas colunas (igual ao ImageCropTemplateDialog):

```
┌─────────────────────────────────────────────────────────┐
│  Gerador de Template com IA                     [X]      │
├──────────────────┬──────────────────────────────────────┤
│                  │                                       │
│  CHAT LATERAL    │         PREVIEW DA IMAGEM             │
│                  │                                       │
│  Formato:        │   [imagem gerada ocupa o espaço       │
│  [selector]      │    proporcional ao formato]           │
│                  │                                       │
│  ┌────────────┐  │                                       │
│  │ Mensagem 1 │  │                                       │
│  │ (user)     │  │                                       │
│  └────────────┘  │                                       │
│  ┌────────────┐  │                                       │
│  │ Resposta   │  │                                       │
│  │ (IA)       │  │                                       │
│  └────────────┘  │                                       │
│                  │                                       │
│  [textarea]      │                                       │
│  [enviar]        │   [Usar este template →]              │
│                  │                                       │
└──────────────────┴──────────────────────────────────────┘
```

**Coluna esquerda (chat):**
- Selector de formato (apenas formatos de impressão, não social media)
- Histórico de mensagens (user + assistant)
- Thumbnails das versões anteriores geradas (para voltar)
- Textarea + botão enviar (Enter envia, Shift+Enter quebra linha)
- Indicador de geração (loading com mensagem "Gerando imagem...")

**Coluna direita (preview):**
- Imagem gerada em tamanho real proporcional ao espaço disponível
- Proporção respeita o formato selecionado
- Botão "Usar este template" → abre ImageCropTemplateDialog com a imagem
- Enquanto gera: skeleton/shimmer no lugar da imagem

### Histórico de versões

O chat mantém as últimas N imagens geradas (N = 5). O usuário pode clicar numa versão anterior para restaurá-la como imagem ativa antes de continuar refinando ou de fazer o crop.

---

## Especificação de API — Backend

### Endpoint

```
POST /v1/ai/template-image-generate
Authorization: Bearer <token>
```

### Request

```typescript
{
  format: {
    type: string;           // ex: "folheto-27x54"
    printWidthCm: number;   // ex: 27
    printHeightCm: number;  // ex: 54
  };
  messages: {
    role: 'user' | 'assistant';
    content: string;
    imageUrl?: string;      // URL CDN da imagem gerada anteriormente (para iteração)
  }[];
}
```

### Response

```typescript
{
  imageUrl: string;         // URL CDN da imagem gerada (salva no bucket)
  assistantMessage: string; // Mensagem em português para exibir no chat
  promptUsed: string;       // Prompt enviado ao GPT-4o (para debug/transparência)
}
```

### Lógica no backend

1. Pega a última mensagem do usuário (em português)
2. Chama GPT-4o (chat) para traduzir + enriquecer o prompt para inglês com contexto de encarte e requisito das 3 zonas — retorna o prompt final em inglês pronto para uso
3. Se houver `imageUrl` na mensagem anterior do assistente: usa GPT-4o Image em modo edição (envia imagem atual + prompt de refinamento em inglês)
4. Se for primeira mensagem: usa GPT-4o Image em modo geração pura com o prompt traduzido
5. Faz download da imagem gerada
6. Salva no bucket de uploads (mesmo pipeline das outras imagens)
7. Retorna URL CDN + mensagem do assistente em português (gerada também pelo GPT-4o chat)

### Dimensões da imagem gerada

GPT-4o Image gera em tamanho fixo internamente, mas o sistema solicita a proporção correta:
- Para `folheto-27x54`: proporção 27:54 = 1:2 (portrait)
- Para `folheto-55x36`: proporção 55:36 ≈ 3:2 (landscape)
- O GPT-4o Image aceita `size` como `1024x1024`, `1792x1024`, `1024x1792` — escolher o mais próximo da proporção do formato

---

## Integração com Features Existentes

### Feature 3 — ImageCropTemplateDialog
Zero mudança. O botão "Usar este template" passa a imagem gerada como se fosse um upload manual. O crop tool não precisa saber a origem da imagem.

### Template Builder
Zero mudança. O resultado do crop gera um `FlyerTemplate` com `imageUrl` nas seções, exatamente como hoje.

### Remoção/Deprecação da Feature 4 (geração via JSON)
O endpoint `POST /v1/ai/template-generate` pode ser mantido por compatibilidade mas o frontend para de usá-lo para geração de templates completos. O `AiTemplateChat` atual na sidebar do Template Builder seria removido ou substituído pelo novo fluxo.

---

## O que NÃO está no escopo desta feature

- Inpainting real (segmentar e editar partes específicas da imagem) — tecnicamente complexo, fica para versão futura
- Geração de texto dentro da imagem — texto é sempre adicionado no template builder
- Geração de logo — sempre adicionado no template builder
- Animações ou templates para vídeo

---

## Estimativa de custo por uso

| Operação | Custo estimado |
|---|---|
| Geração inicial | ~$0.07 |
| Cada refinamento | ~$0.07 |
| Sessão típica (5 iterações) | ~$0.35 |

Valores de referência: GPT-4o Image (abril 2025). Sujeito a alteração conforme pricing da OpenAI.

---

## Decisões em aberto

- [ ] Página nova (`/template-generator`) ou modal grande — a ser decidido durante implementação
- [ ] Quantas versões anteriores manter no histórico (sugestão: 5)
- [ ] Se o `AiTemplateChat` na sidebar do Template Builder deve ser removido ou mantido para refinamentos pontuais
- [ ] Tamanho máximo de imagem a ser gerada (impacta custo e tempo de resposta)
