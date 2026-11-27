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

/** Ações do assistente de elemento: JSON estrito, com imagens possíveis. */
export const TEMPLATE_ELEMENT_CALL: TextCallPoint = {
  effort: 'low',
  legacyMaxTokens: 2000,
  maxCompletionTokens: 8000,
  timeoutMs: 90_000,
};
