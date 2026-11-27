import { TextCallPoint } from '../../ai/config/openai-text-calls';
import { KIT_CANONICAL_DESC_TIMEOUT_MS } from './mc-pipeline.config';

/**
 * Esforço, teto, temperatura e prazo das chamadas de texto e visão dos comerciais (change 42, requisitos
 * "Parâmetros da chamada pela família do modelo", "Esforço de raciocínio por consumidor", "Teto de saída com folga
 * para o raciocínio" e "Prazo por chamada"; valores em PV-11 do `design.md`). O chamador junta o `model` da variável:
 * `{ model, ...PONTO }`. Mesmo formato dos pontos do módulo `ai` (`TextCallPoint`).
 *
 * - `legacyMaxTokens` e `temperature` são os de hoje do ponto, ausentes onde hoje o corpo não os leva: com
 *   `MC_DIRECTOR_MODEL=gpt-4o` o corpo sai como hoje, campo a campo.
 * - `maxCompletionTokens` é o teto da família `gpt-6`, sempre maior que o de hoje porque o raciocínio conta nele.
 */

/**
 * Diretor dos comerciais (job `script`, os quatro formatos): JSON estrito com 1 a 8 cenas ou as falas de até 8
 * ofertas. Hoje sem teto e com `temperature: 0.7`; a família nova ganha teto e esforço `low`. Um roteiro de 8 cenas
 * com raciocínio `low` cabe folgado em 16.000. O prazo de 100 s fica abaixo da expiração de 120 s da fila `mc.llm`: a falha é registrada por nós, não pela expiração do job (PV-11). Vale para o conjunto de tentativas e esperas do job, não por tentativa (R2 da rodada 1): `requestDirectorJson` entrega a cada tentativa só o que resta.
 */
export const MC_DIRECTOR_TOTAL_MS = 100_000;

export const MC_DIRECTOR_CALL: TextCallPoint = {
  effort: 'low',
  temperature: 0.7,
  maxCompletionTokens: 16_000,
  timeoutMs: MC_DIRECTOR_TOTAL_MS,
};

/**
 * Descrição canônica do kit (visão + JSON estrito): `max_tokens: 600` e sem `temperature` hoje. O prazo é o de hoje
 * (`KIT_CANONICAL_DESC_TIMEOUT_MS`, 60 s), que também entra na conta da expiração do job do kit; o teto da família
 * nova (4096) deixa folga para o raciocínio `low` sobre a ficha com a versão em pt-BR.
 */
export const KIT_CANONICAL_DESC_CALL: TextCallPoint = {
  effort: 'low',
  legacyMaxTokens: 600,
  maxCompletionTokens: 4096,
  timeoutMs: KIT_CANONICAL_DESC_TIMEOUT_MS,
};

/** Tradução do ajuste do usuário (pt-BR → inglês, texto livre curto): `max_tokens: 300`, sem `temperature` hoje. */
export const KIT_ADJUSTMENTS_TRANSLATION_CALL: TextCallPoint = {
  effort: 'none',
  legacyMaxTokens: 300,
  maxCompletionTokens: 1200,
  timeoutMs: 30_000,
};

/** Tradução da ficha do kit (inglês → pt-BR, JSON estrito): `max_tokens: 900`, sem `temperature` hoje. */
export const KIT_SHEET_TRANSLATION_CALL: TextCallPoint = {
  effort: 'none',
  legacyMaxTokens: 900,
  maxCompletionTokens: 3600,
  timeoutMs: 30_000,
};

/**
 * Derivação PT → EN de uma cena (JSON estrito com dois textos curtos): hoje sem teto e com `temperature: 0`, que a
 * família nova mantém porque o esforço é `none`.
 */
export const SCENE_DERIVATION_CALL: TextCallPoint = {
  effort: 'none',
  temperature: 0,
  maxCompletionTokens: 1024,
  timeoutMs: 30_000,
};
