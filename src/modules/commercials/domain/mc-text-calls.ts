import { TextCallPoint } from '../../ai/config/openai-text-calls';

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
 * com raciocínio `low` cabe folgado em 16.000. O prazo de 100 s fica abaixo da expiração de 120 s da fila `mc.llm`: a falha é registrada por nós, não pela expiração do job (PV-11).
 */
export const MC_DIRECTOR_CALL: TextCallPoint = {
  effort: 'low',
  temperature: 0.7,
  maxCompletionTokens: 16_000,
  timeoutMs: 100_000,
};
