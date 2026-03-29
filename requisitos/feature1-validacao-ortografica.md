# Feature 1 — Validação Ortográfica de Produtos com IA

## Visão Geral

Validação ortográfica assistida por IA para os textos dos produtos dentro de um encarte aberto no editor. O objetivo é garantir que nenhum texto incorreto chegue ao encarte final antes da impressão ou publicação.

A IA atua como assistente — o usuário tem controle total sobre aceitar ou rejeitar cada sugestão individualmente.

---

## Regras de Negócio

- A validação é **sempre manual** — acionada por um botão no editor, nunca automática.
- São validados os campos de texto livre dos produtos do encarte: `name`, `observation` e `badgeText`.
- Campos numéricos (`price`, `originalPrice`, `unit`) e campos de configuração visual (`badgeColor`, `badgePosition`, `imageUrl`) **não são validados**.
- O retorno da IA contém **apenas os produtos que possuem erro** — produtos sem erro não aparecem no painel.
- Se nenhum erro for encontrado, exibe mensagem de estado vazio: "Nenhum erro encontrado".
- As sugestões são aceitas **uma por uma** — não existe "aceitar todas".
- Aceitar uma sugestão atualiza o produto no `editorStore` do frontend. A correção **não é persistida automaticamente** — ela é salva junto com o flyer na próxima vez que o usuário salvar normalmente.
- A correção é aplicada **apenas no encarte atual**. O catálogo de produtos (`/v1/products`) não é alterado.
- O usuário pode re-acionar a validação a qualquer momento, inclusive após ter aceito sugestões anteriores ou editado produtos manualmente.
- Produtos sem conteúdo nos campos de texto (ex: `observation` nulo ou vazio) têm esses campos ignorados na validação.
- Um encarte pode ter até **120 produtos**. Todos são enviados em uma única chamada (batch) para a IA.

---

## Arquitetura Técnica

### Módulo Backend

Criar novo módulo `ai` seguindo o padrão NestJS do projeto:

```
src/modules/ai/
├── ai.module.ts
├── ai.controller.ts
├── ai.service.ts
└── dto/
    ├── spell-check-request.dto.ts
    └── spell-check-response.dto.ts
```

Registrar `AiModule` em `app.module.ts`.

### Variável de Ambiente

Adicionar ao `.env` e `.env.example`:

```
OPENAI_API_KEY=sk-...
```

### Endpoint

```
POST /v1/ai/spell-check
Authorization: Bearer <token>
Content-Type: application/json
```

**Request body:**

```json
{
  "products": [
    {
      "id": "uuid-do-produto",
      "name": "Arroz Tipo 1 Camil 5kg",
      "observation": "Produto fresquíssimo",
      "badgeText": "OFERTA ESPECIAL"
    }
  ]
}
```

- `id`: UUID do produto no encarte (usado para correlacionar a sugestão com o produto no frontend)
- `name`: obrigatório, string
- `observation`: opcional, string ou null
- `badgeText`: opcional, string ou null

**Response body (sucesso):**

```json
{
  "success": true,
  "data": {
    "corrections": [
      {
        "productId": "uuid-do-produto",
        "field": "name",
        "original": "Arroz Tipo 1 Camil 5kg",
        "suggestion": "Arroz Tipo 1 Camil 5 kg"
      },
      {
        "productId": "uuid-do-produto",
        "field": "observation",
        "original": "Produto fresquíssimo",
        "suggestion": "Produto fresquíssimo"
      }
    ]
  }
}
```

- `field`: `"name"` | `"observation"` | `"badgeText"`
- Se um produto tiver erros em mais de um campo, retorna uma entrada por campo afetado.
- Se não houver erros em nenhum produto, `corrections` retorna array vazio `[]`.

**Response body (erro de validação):**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "O campo products deve ser um array não vazio."
  }
}
```

**Response body (erro da IA):**

```json
{
  "success": false,
  "error": {
    "code": "AI_SERVICE_ERROR",
    "message": "Não foi possível processar a validação. Tente novamente."
  }
}
```

### Lógica do Service (`AiService.spellCheck`)

1. Receber o array de produtos.
2. Filtrar os campos de texto: montar lista apenas com os campos não nulos/vazios.
3. Construir o prompt (ver seção abaixo).
4. Chamar a API da OpenAI com `model: "gpt-4o-mini"` e `response_format: { type: "json_object" }`.
5. Fazer parse do JSON retornado.
6. Validar que o retorno possui a chave `corrections` como array.
7. Se a validação do retorno falhar (JSON malformado ou estrutura inesperada), retornar `AI_SERVICE_ERROR`.
8. Retornar as correções ao controller.

### Estrutura do Prompt

**System prompt:**

```
Você é um revisor ortográfico especializado em textos de produtos para encartes de supermercado em português brasileiro.

Analise os textos fornecidos e identifique erros ortográficos, gramaticais ou de digitação.

Regras:
- Corrija apenas erros claros de ortografia, acentuação, gramática ou digitação.
- NÃO altere nomes de marcas, nomes próprios ou siglas comerciais.
- NÃO altere valores numéricos, unidades de medida ou códigos.
- NÃO faça sugestões estilísticas — apenas corrija erros objetivos.
- Retorne SOMENTE os campos que possuem erro. Campos corretos devem ser omitidos.
- Responda SEMPRE em JSON com a estrutura exata abaixo, sem texto adicional.

Estrutura esperada:
{
  "corrections": [
    {
      "productId": "<id do produto>",
      "field": "<name | observation | badgeText>",
      "original": "<texto original>",
      "suggestion": "<texto corrigido>"
    }
  ]
}

Se não houver erros em nenhum produto, retorne: { "corrections": [] }
```

**User prompt (gerado dinamicamente):**

```
Analise os seguintes produtos e retorne apenas os campos com erros ortográficos:

[
  { "productId": "uuid-1", "field": "name", "text": "Arroz Tipo 1 Camil 5kg" },
  { "productId": "uuid-1", "field": "observation", "text": "Produto fresquíssimo" },
  { "productId": "uuid-2", "field": "name", "text": "Feijão Preto Kicaldo 1kg" },
  { "productId": "uuid-2", "field": "badgeText", "text": "OFERTA SPECAIL" }
]
```

Cada produto gera até 3 entradas (uma por campo não vazio). O service monta esse array flat antes de enviar.

### DTO de Request

```typescript
// spell-check-request.dto.ts
class SpellCheckProductDto {
  @IsUUID()
  id: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  observation?: string | null;

  @IsOptional()
  @IsString()
  badgeText?: string | null;
}

class SpellCheckRequestDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SpellCheckProductDto)
  products: SpellCheckProductDto[];
}
```

### DTO de Response

```typescript
// spell-check-response.dto.ts
class CorrectionDto {
  productId: string;
  field: 'name' | 'observation' | 'badgeText';
  original: string;
  suggestion: string;
}

class SpellCheckResponseDto {
  corrections: CorrectionDto[];
}
```

---

## Implementação Frontend

### Onde fica o botão

No componente `EditorToolbar.tsx`. Botão com ícone de revisão de texto (ex: ícone `SpellCheck` ou `CheckSquare` do Lucide). Texto: "Revisar Textos".

### Fluxo de interação

1. Usuário clica em "Revisar Textos".
2. Frontend coleta os produtos do `editorStore` (`state.products`).
3. Monta o payload com `id`, `name`, `observation`, `badgeText` de cada produto.
4. Exibe estado de loading no botão ("Analisando...").
5. Chama `POST /v1/ai/spell-check`.
6. Ao receber resposta:
   - Se `corrections` vazio → exibe toast/mensagem: "Nenhum erro encontrado nos textos."
   - Se há correções → abre painel lateral com a lista de sugestões.
7. Painel lateral exibe, para cada sugestão:
   - Nome do produto (para identificação)
   - Campo afetado (ex: "Nome", "Observação", "Badge")
   - Texto original (riscado ou em vermelho)
   - Texto sugerido (em verde ou destacado)
   - Botão "Aceitar" e botão "Ignorar"
8. Ao clicar "Aceitar":
   - Chama `editorStore.updateProduct(productId, { [field]: suggestion })`
   - Remove o item da lista do painel
9. Ao clicar "Ignorar":
   - Remove o item da lista do painel sem alterar nada
10. Quando a lista fica vazia → exibe mensagem "Todas as sugestões foram revisadas."

### Estado de re-validação

O painel pode ser fechado e o botão "Revisar Textos" pode ser acionado novamente a qualquer momento. Cada acionamento inicia uma nova sessão de validação, descartando sugestões pendentes da sessão anterior.

### Tratamento de erro no frontend

Se a chamada retornar erro (`AI_SERVICE_ERROR` ou falha de rede) → exibe toast de erro: "Não foi possível realizar a validação. Tente novamente."

---

## Dependências

### Backend

- Pacote `openai` (SDK oficial da OpenAI para Node.js): `npm install openai`
- Variável de ambiente `OPENAI_API_KEY`

### Frontend

- Nenhuma dependência nova — usa o `httpClient` existente e `editorStore` existente.

---

## Estimativa de Custo por Uso

Referência: GPT-4o-mini (preços aproximados de 2025)
- Input: ~$0.15 por 1M tokens
- Output: ~$0.60 por 1M tokens

Um encarte com 120 produtos com todos os campos preenchidos gera aproximadamente 800–1200 tokens de input e ~300 tokens de output. Custo estimado por validação: **< $0.001** (menos de um décimo de centavo de dólar).

---

## Casos de Borda

| Situação | Comportamento esperado |
|----------|----------------------|
| Encarte sem produtos | Botão desabilitado ou toast "Nenhum produto no encarte" |
| Produto sem `observation` e sem `badgeText` | Apenas `name` é enviado para esse produto |
| IA retorna JSON inválido | Retorna `AI_SERVICE_ERROR`, exibe toast de erro no frontend |
| `OPENAI_API_KEY` não configurada | Retorna `AI_SERVICE_ERROR` com log de erro no servidor |
| Usuário aceita sugestão e depois salva o flyer | A correção é persistida normalmente no `configuration` JSONB do flyer |
| Usuário aceita sugestão mas fecha sem salvar | A correção é perdida — comportamento idêntico a qualquer edição não salva |
| Re-validação após aceitar sugestões | A IA avalia o estado atual dos produtos (já corrigidos) — pode retornar lista vazia |
