import { ChatCallSpec } from './openai-chat-params';

/**
 * Esforço, teto, temperatura e prazo de cada chamada de texto e visão do módulo `ai` que não é uma das cinco
 * features de produto (change 42, requisitos "Parâmetros da chamada pela família do modelo", "Esforço de raciocínio
 * por consumidor", "Teto de saída com folga para o raciocínio" e "Prazo por chamada"; valores em PV-7 do
 * `design.md`). O serviço junta o `model` da variável: `{ model, ...PONTO }`.
 *
 * - `legacyMaxTokens` e `temperature` são os de hoje do ponto, ausentes onde hoje o corpo não os leva: a família de
 *   hoje (`OPENAI_TEXT_MODEL=gpt-4o`) sai com o corpo de hoje campo a campo.
 * - `maxCompletionTokens` é o teto da família `gpt-6`, sempre maior que o de hoje porque o raciocínio conta nele.
 */
export type TextCallPoint = Omit<ChatCallSpec, 'model'>;

/** Configuração do template (Gerar template): JSON estrito grande, com as imagens do usuário na conversa. */
export const TEMPLATE_CONFIGURATION_CALL: TextCallPoint = {
  effort: 'low',
  legacyMaxTokens: 4000,
  maxCompletionTokens: 16_000,
  timeoutMs: 120_000,
};

/** Leitura das referências do template por imagem: até 3 imagens em `detail: high`, texto livre. */
export const TEMPLATE_IMAGE_REFERENCE_CALL: TextCallPoint = {
  effort: 'low',
  temperature: 0.1,
  legacyMaxTokens: 700,
  maxCompletionTokens: 4096,
  timeoutMs: 60_000,
};

/** Prompt em inglês do template por imagem: tradução e enriquecimento, texto livre, sem raciocínio. */
export const TEMPLATE_IMAGE_PROMPT_CALL: TextCallPoint = {
  effort: 'none',
  temperature: 0.2,
  legacyMaxTokens: 500,
  maxCompletionTokens: 2000,
  timeoutMs: 30_000,
};

/** Resposta curta em português ao usuário do template por imagem, sem raciocínio. */
export const TEMPLATE_IMAGE_REPLY_CALL: TextCallPoint = {
  effort: 'none',
  temperature: 0.7,
  legacyMaxTokens: 150,
  maxCompletionTokens: 600,
  timeoutMs: 20_000,
};

/** Intenção da imagem (template por imagem e em camadas): classificação curta em JSON estrito, sem raciocínio. */
export const IMAGE_INTENT_CALL: TextCallPoint = {
  effort: 'none',
  temperature: 0,
  legacyMaxTokens: 300,
  maxCompletionTokens: 1024,
  timeoutMs: 20_000,
};

/** Leitura das referências do template em camadas: `detail: high`, texto livre, sem `temperature` hoje. */
export const TEMPLATE_LAYERS_REFERENCE_CALL: TextCallPoint = {
  effort: 'low',
  legacyMaxTokens: 400,
  maxCompletionTokens: 3000,
  timeoutMs: 60_000,
};

/** Composição do template em camadas (paleta e elementos): JSON estrito. */
export const TEMPLATE_LAYERS_COMPOSITION_CALL: TextCallPoint = {
  effort: 'low',
  temperature: 0.4,
  legacyMaxTokens: 1000,
  maxCompletionTokens: 8000,
  timeoutMs: 90_000,
};

/**
 * Juízes de EAN (A e B): visão com `json_object`, `temperature: 0` na família de hoje. O teto de saída também é o
 * que um julgamento sem `usage` custa ao teto em dólar do job (`custoDe`), por isso os dois tetos são obrigatórios.
 */
export const EAN_JUDGE_CALL: TextCallPoint & { legacyMaxTokens: number } = {
  effort: 'low',
  temperature: 0,
  legacyMaxTokens: 700,
  maxCompletionTokens: 4096,
  timeoutMs: 60_000,
};

/** Ações do assistente de elemento: JSON estrito, com imagens possíveis. */
export const TEMPLATE_ELEMENT_CALL: TextCallPoint = {
  effort: 'low',
  legacyMaxTokens: 2000,
  maxCompletionTokens: 8000,
  timeoutMs: 90_000,
};

/** Layout da seção social: JSON livre (`json_object`); hoje sem teto, que só a família nova ganha. */
export const SOCIAL_LAYOUT_CALL: TextCallPoint = {
  effort: 'low',
  temperature: 0.3,
  maxCompletionTokens: 8000,
  timeoutMs: 60_000,
};

/**
 * Plano de montagem do encarte: o JSON cresce com o número de produtos. Hoje `min(12000, 900 + 65n)`; na família nova
 * `min(32000, 4000 + 130n)` (sempre maior: 14.140 para 78 produtos contra 5.970).
 */
export function flyerAssemblyPlanCall(productCount: number): TextCallPoint {
  return {
    effort: 'low',
    temperature: 0.2,
    legacyMaxTokens: Math.min(12_000, 900 + productCount * 65),
    maxCompletionTokens: Math.min(32_000, 4000 + productCount * 130),
    timeoutMs: 90_000,
  };
}

/** Roteiro do mascote: texto curto em JSON estrito; o tom `animado` é mais criativo (0,7) que os outros (0,4). */
export function mascotScriptCall(animated: boolean): TextCallPoint {
  return {
    effort: 'none',
    temperature: animated ? 0.7 : 0.4,
    legacyMaxTokens: 600,
    maxCompletionTokens: 2400,
    timeoutMs: 30_000,
  };
}
