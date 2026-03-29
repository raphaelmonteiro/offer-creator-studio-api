# Feature 4 — Criação Assistida de Templates com IA

## Visão Geral

Implementação de um fluxo de criação assistida de templates via chat no painel lateral do Template Builder. O usuário fornece tema, contexto textual e imagens de referência; o GPT-4o gera a estrutura completa do template em JSON compatível com o motor existente. Quando necessário, o DALL-E 3 gera imagens temáticas (fundos, decorações) que são salvas no bucket e incorporadas ao template.

A conversa é **multi-turno** — o usuário pode refinar o resultado com mensagens subsequentes sem perder o contexto. O template gerado é carregado no canvas do Template Builder para edição manual, e salvo na lista de templates pelo fluxo padrão existente (botão "Salvar").

---

## Regras de Negócio

- A interface de chat fica no **painel lateral do Template Builder**, como uma aba ou seção dedicada.
- O usuário deve selecionar o **formato do template** antes de iniciar a geração (dropdown com os tipos disponíveis, mesmo da Feature 3).
- O usuário pode enviar até **3 imagens de referência** (JPG ou PNG) junto com o primeiro prompt.
- A conversa é **multi-turno**: o usuário pode enviar mensagens de refinamento ("deixa o header mais escuro", "adiciona o nome da loja em destaque") e o sistema regenera o template mantendo o contexto anterior.
- O backend é **stateless** — o frontend envia o histórico completo de mensagens a cada chamada.
- O template gerado **não é salvo automaticamente** — é carregado no canvas do Template Builder. O usuário salva manualmente pelo botão "Salvar" já existente, exatamente como hoje.
- O template gerado deve ter estrutura 100% compatível com o `FlyerTemplate` existente, permitindo edição completa no Template Builder após a geração.
- A decisão de gerar imagens com DALL-E 3 é **da IA** — o GPT-4o inclui placeholders no JSON quando julgar necessário. O usuário não tem toggle para isso.
- Todas as imagens geradas pelo DALL-E 3 são baixadas e salvas no bucket antes de serem incorporadas ao template.
- O idioma da conversa é **português (pt-BR)**.
- Limite de uso: **sem restrições por enquanto**.

---

## Arquitetura Técnica

### Módulo Backend

Adicionado ao módulo `ai` das features anteriores:

```
src/modules/ai/
├── ai.module.ts
├── ai.controller.ts
├── ai.service.ts
└── dto/
    ├── ...                                   # Features 1 e 2
    ├── template-generate-request.dto.ts      # Feature 4
    └── template-generate-response.dto.ts     # Feature 4
```

### Variáveis de Ambiente

Já existem das features anteriores:
```
OPENAI_API_KEY=sk-...
```

Nenhuma variável nova necessária.

---

## Endpoint

```
POST /v1/ai/template-generate
Authorization: Bearer <token>
Content-Type: application/json
```

### Request Body

```json
{
  "format": {
    "type": "folheto-20x27",
    "artWidthCm": 27.5,
    "artHeightCm": 27.5,
    "headerHeightCm": 6,
    "footerHeightCm": 4
  },
  "messages": [
    {
      "role": "user",
      "content": "Crie um template de Páscoa com tons pastéis e elementos decorativos de coelhos e ovos coloridos. Header impactante com o nome da loja, footer com informações de validade.",
      "images": ["data:image/jpeg;base64,...", "data:image/jpeg;base64,..."]
    },
    {
      "role": "assistant",
      "content": "Aqui está o template de Páscoa! Usei tons pastéis com gradiente rosa para o header e um fundo suave para o footer. Gerei um background temático com elementos de Páscoa."
    },
    {
      "role": "user",
      "content": "Deixa o header com fundo gerado pela IA e aumenta o tamanho do texto principal."
    }
  ]
}
```

**Campos:**
- `format`: dimensões do formato selecionado (necessário para o GPT-4o calcular coordenadas corretamente)
- `messages`: histórico completo da conversa — o frontend envia tudo a cada chamada
- `messages[].images`: base64 das imagens de referência — apenas nas mensagens do usuário que as incluem (geralmente só a primeira)
- Mensagens `role: "assistant"` são apenas texto (a IA não precisa re-processar os templates anteriores, eles estão implícitos no histórico)

### Response Body (sucesso)

```json
{
  "success": true,
  "data": {
    "assistantMessage": "Aqui está o template atualizado! O header agora tem um background gerado com elementos temáticos de Páscoa e o texto principal ficou maior.",
    "configuration": {
      "header": {
        "id": "header",
        "name": "Header",
        "widthCm": 27.5,
        "heightCm": 6,
        "background": {
          "type": "image",
          "imageUrl": "https://cdn.seudominio.com/uploads/templates/easter-header-1718123456.jpg",
          "imageSize": "cover",
          "imagePosition": "center",
          "imageOpacity": 1
        },
        "elements": [
          {
            "id": "el-1",
            "type": "text",
            "x": 40,
            "y": 60,
            "width": 500,
            "height": 80,
            "zIndex": 2,
            "content": "SUPERMERCADO EXEMPLO",
            "fontSize": 48,
            "fontFamily": "Arial",
            "fontWeight": "bold",
            "color": "#FFFFFF",
            "textAlign": "center"
          }
        ]
      },
      "footer": {
        "id": "footer",
        "name": "Footer",
        "widthCm": 27.5,
        "heightCm": 4,
        "background": {
          "type": "gradient",
          "gradientStart": "#F8BBD9",
          "gradientEnd": "#F48FB1",
          "gradientAngle": 135
        },
        "elements": []
      },
      "bodyBackground": {
        "type": "solid",
        "color": "#FFF9C4"
      }
    },
    "imagesGenerated": true
  }
}
```

### Response Body (erro de validação do JSON gerado)

```json
{
  "success": false,
  "error": {
    "code": "TEMPLATE_GENERATION_ERROR",
    "message": "Não foi possível gerar o template. Tente novamente com uma descrição diferente."
  }
}
```

---

## Lógica do Service (`AiService.generateTemplate`)

### Passo 1 — Construir o array de mensagens para o GPT-4o

1. Montar o **system prompt** (ver seção abaixo).
2. Para cada mensagem do histórico recebido:
   - `role: "user"` sem imagens → mensagem de texto simples
   - `role: "user"` com imagens → mensagem com content array (texto + image_url blocks em base64)
   - `role: "assistant"` → mensagem de texto simples (só o `assistantMessage`)
3. Adicionar a última mensagem do usuário (a atual) com suas imagens, se houver.

### Passo 2 — Chamar o GPT-4o

```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  response_format: { type: 'json_object' },
  messages: constructedMessages,
  max_tokens: 4000,
});
```

### Passo 3 — Processar o retorno

O GPT-4o retorna JSON com a estrutura:
```json
{
  "assistantMessage": "Mensagem explicando o que foi feito",
  "configuration": { ...FlyerTemplate... }
}
```

### Passo 4 — Resolver placeholders do DALL-E 3

1. Percorrer todos os campos `imageUrl` e `src` do `configuration` retornado.
2. Para cada valor que começa com `"GENERATE:"`:
   - Extrair o prompt após o prefixo: `"GENERATE: coelhos de páscoa em aquarela, fundo pastel"`
   - Chamar DALL-E 3:
     ```typescript
     await openai.images.generate({
       model: 'dall-e-3',
       prompt: extractedPrompt,
       size: '1024x1024',
       quality: 'standard',
       n: 1,
     });
     ```
   - Fazer download da imagem gerada (URL temporária retornada pelo DALL-E 3).
   - Salvar via `UploadsService.saveFile()` na pasta `templates/`.
   - Substituir o placeholder pela URL CDN retornada.
3. Processar todos os placeholders encontrados (podem ser múltiplos — um por imagem gerada).

### Passo 5 — Validar o JSON final

Verificar que o `configuration` retornado contém:
- `header` com `id`, `name`, `widthCm`, `heightCm`, `background`, `elements`
- `footer` com os mesmos campos
- Todos os elementos possuem `id`, `type`, `x`, `y`, `width`, `height`, `zIndex`
- Nenhum campo `imageUrl` ou `src` contém mais placeholders `GENERATE:` (todos devem ter sido resolvidos)

Se a validação falhar → retornar `TEMPLATE_GENERATION_ERROR`.

### Passo 6 — Retornar

Retornar `{ assistantMessage, configuration, imagesGenerated }`.

---

## System Prompt do GPT-4o

```
Você é um designer especialista em templates para encartes de supermercado em português brasileiro.
Seu trabalho é criar e refinar templates visuais com base nas instruções do usuário.

## FORMATO DO TEMPLATE

O template deve ser retornado SEMPRE em JSON com esta estrutura exata:

{
  "assistantMessage": "<mensagem em português explicando o que foi criado/alterado>",
  "configuration": {
    "header": {
      "id": "header",
      "name": "Header",
      "widthCm": <artWidthCm fornecido>,
      "heightCm": <headerHeightCm fornecido>,
      "background": <CanvasBackground>,
      "elements": [<CanvasElement>]
    },
    "footer": {
      "id": "footer",
      "name": "Footer",
      "widthCm": <artWidthCm fornecido>,
      "heightCm": <footerHeightCm fornecido>,
      "background": <CanvasBackground>,
      "elements": [<CanvasElement>]
    },
    "bodyBackground": <CanvasBackground>
  }
}

## TIPOS DE DADOS

### CanvasBackground
Escolha um dos três tipos:

Sólido:   { "type": "solid", "color": "#RRGGBB" }

Gradiente: {
  "type": "gradient",
  "gradientStart": "#RRGGBB",
  "gradientEnd": "#RRGGBB",
  "gradientAngle": 0-360
}

Imagem gerada pela IA: {
  "type": "image",
  "imageUrl": "GENERATE: <prompt em inglês descrevendo a imagem>",
  "imageSize": "cover",
  "imagePosition": "center",
  "imageOpacity": 1
}

### TextElement
{
  "id": "<uuid único>",
  "type": "text",
  "x": <pixels>,
  "y": <pixels>,
  "width": <pixels>,
  "height": <pixels>,
  "zIndex": <1-10>,
  "content": "<texto>",
  "fontSize": <número>,
  "fontFamily": "Arial",
  "fontWeight": "normal|bold",
  "fontStyle": "normal|italic",
  "color": "#RRGGBB",
  "textAlign": "left|center|right",
  "lineHeight": 1.2,
  "letterSpacing": 0,
  "textTransform": "none|uppercase|lowercase",
  "backgroundColor": "#RRGGBB ou null",
  "padding": <pixels ou null>,
  "borderRadius": <pixels ou null>
}

### ImageElement
{
  "id": "<uuid único>",
  "type": "image",
  "x": <pixels>,
  "y": <pixels>,
  "width": <pixels>,
  "height": <pixels>,
  "zIndex": <1-10>,
  "src": "GENERATE: <prompt em inglês>" ou "<URL existente>",
  "opacity": 1,
  "objectFit": "cover|contain",
  "borderRadius": 0
}

## SISTEMA DE COORDENADAS

As coordenadas (x, y, width, height) são em PIXELS considerando escala de 37.795px por cm (96dpi).

Dimensões calculadas a partir dos valores de formato fornecidos:
- Largura total do canvas: artWidthCm × 37.795
- Altura do header: headerHeightCm × 37.795
- Altura do footer: footerHeightCm × 37.795

Exemplo para folheto-20x27 (artWidth=27.5cm, headerHeight=6cm, footerHeight=4cm):
- Canvas width: 27.5 × 37.795 ≈ 1039px
- Header height: 6 × 37.795 ≈ 227px
- Footer height: 4 × 37.795 ≈ 151px

Posicione todos os elementos dentro dos limites de sua seção.

## REGRAS DE GERAÇÃO DE IMAGENS

Use o placeholder "GENERATE: <prompt>" APENAS quando uma imagem gerada por IA agregar valor real ao design (fundos temáticos, decorações, texturas). Não abuse — prefira gradientes e cores para casos simples.

Prompts para GENERATE devem ser em INGLÊS, descritivos e focados em resultado visual.
Exemplos:
- "GENERATE: Easter bunnies and colorful eggs watercolor style, pastel background, decorative"
- "GENERATE: Christmas snowflakes and pine branches, dark red background, festive pattern"
- "GENERATE: abstract supermarket promotional background, red and yellow gradient, modern geometric shapes"

## REGRAS DE REFINAMENTO

Quando o usuário pedir alterações:
- Mantenha tudo que não foi mencionado igual ao template anterior
- Altere APENAS o que foi solicitado
- Não regere imagens que já foram geradas (preserve as URLs CDN existentes)
- Se o usuário pedir nova imagem, use o placeholder GENERATE novamente

## REGRAS GERAIS

- Use cores vibrantes e adequadas para material promocional de supermercado
- Textos devem ser legíveis — bom contraste com o fundo
- O body (bodyBackground) é o fundo das áreas de produtos — use cores neutras ou suaves
- Responda sempre em português no assistantMessage
- NUNCA inclua campos extras fora do schema definido
- IDs dos elementos devem ser únicos (use formato "el-<número>")
```

---

## DTOs

### `TemplateGenerateRequestDto`

```typescript
class FormatDto {
  @IsString()
  type: string;

  @IsNumber()
  artWidthCm: number;

  @IsNumber()
  artHeightCm: number;

  @IsNumber()
  headerHeightCm: number;

  @IsNumber()
  footerHeightCm: number;
}

class ChatMessageDto {
  @IsEnum(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[]; // base64 data URLs — apenas em mensagens do usuário
}

class TemplateGenerateRequestDto {
  @ValidateNested()
  @Type(() => FormatDto)
  format: FormatDto;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}
```

---

## Implementação Frontend

### Onde fica

Em `TemplateBuilder.tsx`, como uma nova aba ou seção no painel lateral existente. Aba com ícone de IA (ex: `Sparkles` do Lucide) e label "Assistente IA".

### Novo componente

```
src/components/template-builder/
└── AiTemplateChat.tsx   # Painel de chat completo
```

### Estado interno do componente

```typescript
{
  messages: ChatMessage[],          // histórico completo exibido no chat
  inputText: string,                // texto do input atual
  referenceImages: File[],          // max 3 imagens (apenas para o próximo envio)
  isGenerating: boolean,            // loading durante chamada à IA
  hasGenerated: boolean,            // se já houve ao menos uma geração
}
```

### Fluxo de interação

1. Usuário seleciona o formato no Template Builder (dropdown já existente).
2. Abre o painel "Assistente IA".
3. Digita o prompt inicial (ex: "Crie um template de Natal com tons vermelhos e dourados").
4. Opcionalmente, faz upload de até 3 imagens de referência via botão de anexo.
5. Clica em "Gerar" (ou Enter).
6. Estado de loading: mensagem "Gerando template..." aparece no chat. Se `imagesGenerated` for true, exibir "Gerando imagens com IA..." como detalhe adicional.
7. Ao receber resposta:
   - Mensagem do assistente aparece no chat (o `assistantMessage`).
   - `templateStore` é atualizado com o `configuration` retornado via `templateStore.loadTemplate`-equivalente (carrega a configuration no canvas sem salvar).
   - Canvas reflete o template gerado imediatamente.
   - Imagens de referência são limpas (não reenviar em mensagens futuras).
8. Usuário pode continuar digitando refinamentos na mesma conversa.
9. Quando satisfeito, clica no botão "Salvar" já existente no Template Builder — salva normalmente via `templateStore.saveTemplate()`.

### Como enviar mensagens ao backend

```typescript
// Montar payload para cada envio
const payload = {
  format: {
    type: selectedFormat,
    artWidthCm: formatDimensions.artWidth,
    artHeightCm: formatDimensions.artHeight,
    headerHeightCm: formatDimensions.headerHeight,
    footerHeightCm: formatDimensions.footerHeight,
  },
  messages: [
    ...conversationHistory,  // histórico anterior (sem imagens — já foram processadas)
    {
      role: 'user',
      content: inputText,
      images: referenceImages.length > 0
        ? await Promise.all(referenceImages.map(fileToBase64))
        : undefined,
    }
  ]
};
```

As imagens de referência são convertidas para base64 no frontend antes do envio (`FileReader` ou `canvas.toDataURL()`).

### Limitação de histórico

Para evitar payloads excessivamente grandes em conversas longas, o frontend envia no máximo as **últimas 10 mensagens** do histórico. Mensagens mais antigas são descartadas silenciosamente.

### Tratamento de erros no frontend

- `TEMPLATE_GENERATION_ERROR` → mensagem no chat: "Não consegui gerar o template. Tente descrever de forma diferente ou simplificar o pedido."
- Timeout ou erro de rede → mensagem no chat: "Ocorreu um erro. Tente novamente."
- Tempo estimado de resposta: 15–45 segundos (mais longo quando DALL-E 3 é acionado) — manter loading visível durante todo o processo.

---

## Dependências

### Backend
- Pacote `openai` — já adicionado na Feature 1.
- Nenhuma dependência nova.

### Frontend
- Nenhuma dependência nova.

---

## Fluxo Completo (Diagrama em Texto)

```
Frontend                          Backend                         APIs Externas
   │                                 │                                  │
   │─── POST /v1/ai/template-generate ──>│                                  │
   │    { format, messages[] }       │                                  │
   │                                 │─── chat.completions (GPT-4o) ──>│
   │                                 │    { system_prompt,              │
   │                                 │      messages com histórico,     │
   │                                 │      imagens de referência }     │
   │                                 │<─── { assistantMessage,          │
   │                                 │       configuration com          │
   │                                 │       GENERATE: placeholders }──│
   │                                 │                                  │
   │                          [Para cada GENERATE: encontrado]         │
   │                                 │─── images.generate (DALL-E 3) ──>│
   │                                 │<─── URL temporária ─────────────│
   │                                 │─── download + UploadsService     │
   │                                 │    → CDN URL                     │
   │                                 │─── substituir placeholder        │
   │                                 │    por CDN URL                   │
   │                                 │                                  │
   │                          [Validação do JSON final]                │
   │                                 │                                  │
   │<── { assistantMessage,          │                                  │
   │     configuration,              │                                  │
   │     imagesGenerated } ──────────│                                  │
   │                                 │                                  │
   [templateStore carrega config]    │                                  │
   [canvas renderiza template]       │                                  │
   [usuário edita / refina]          │                                  │
   [usuário clica Salvar]            │                                  │
   │─── POST /v1/templates ─────────>│                                  │
   │<── { id, ... } ────────────────│                                  │
```

---

## Casos de Borda

| Situação | Comportamento esperado |
|----------|----------------------|
| Usuário não selecionou formato | Botão "Gerar" desabilitado com tooltip "Selecione um formato primeiro" |
| GPT-4o retorna JSON inválido | Retorna `TEMPLATE_GENERATION_ERROR`; usuário pode tentar novamente |
| DALL-E 3 falha em uma imagem | Backend registra o erro em log, substitui o placeholder por string vazia e prossegue com o restante do template |
| Placeholder `GENERATE:` mal formado | Backend trata como prompt genérico: "promotional supermarket background" |
| Usuário envia 4ª imagem de referência | Frontend bloqueia o upload: "Máximo de 3 imagens de referência" |
| Imagem de referência > 5MB | Frontend recusa antes de converter para base64: "Imagem muito grande. Máximo 5MB por referência" |
| Resposta demora > 60s | Frontend exibe timeout e libera o input para nova tentativa |
| Usuário refina sem ter gerado ainda | Não é possível — o input só fica disponível após o formato ser selecionado |
| Canvas já tem um template em edição quando a IA gera | O canvas é substituído pelo template gerado. Uma mensagem de confirmação é exibida: "Isso vai substituir o template atual. Continuar?" |
| `OPENAI_API_KEY` não configurada | Retorna `TEMPLATE_GENERATION_ERROR` com log no servidor |
