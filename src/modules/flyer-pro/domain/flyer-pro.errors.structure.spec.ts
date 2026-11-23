import { HttpException } from '@nestjs/common';
import {
  flyerProNoItems,
  flyerProStructureAiBusy,
  flyerProStructureAiDisabled,
  flyerProStructureAiFailed,
  flyerProStructureStateInvalid,
} from './flyer-pro.errors';

/** O envelope que o `HttpExceptionFilter` monta com o `getResponse()` de cada fábrica. */
const bodyOf = (error: HttpException) => ({
  status: error.getStatus(),
  ...(error.getResponse() as object),
});

const SUGGESTION_ID = '0f6d2f0e-6c1b-4c56-9a57-3d7b1e2a9c40';

describe('fábricas de erro da sugestão de estrutura (N19)', () => {
  it('FLYER_PRO_STRUCTURE_STATE_INVALID: 422 com a lista em `issues`, fora de `details`', () => {
    const issues = [
      { field: 'sections', code: 'TOO_FEW_SECTIONS' },
      { field: 'sections[1].id', code: 'SECTION_DUPLICATED' },
    ];
    const body = bodyOf(flyerProStructureStateInvalid(issues));
    expect(body).toEqual({
      status: 422,
      code: 'FLYER_PRO_STRUCTURE_STATE_INVALID',
      message: 'O retrato da Estrutura enviado está incoerente.',
      issues,
    });
    expect(body).not.toHaveProperty('details');
  });

  it.each(['FLAG', 'NO_API_KEY', 'MODEL_PRICE_UNKNOWN'] as const)(
    'FLYER_PRO_STRUCTURE_AI_DISABLED: 422 com `details.reason` %s',
    (reason) => {
      expect(bodyOf(flyerProStructureAiDisabled(reason))).toEqual({
        status: 422,
        code: 'FLYER_PRO_STRUCTURE_AI_DISABLED',
        message: 'A sugestão por IA está desligada neste ambiente.',
        details: { reason },
      });
    },
  );

  it('FLYER_PRO_STRUCTURE_AI_BUSY: 429 com a mensagem do motivo e `retryAfterSeconds` em `details`', () => {
    expect(bodyOf(flyerProStructureAiBusy({ reason: 'IN_FLIGHT', retryAfterSeconds: 7 }))).toEqual({
      status: 429,
      code: 'FLYER_PRO_STRUCTURE_AI_BUSY',
      message: 'Já há uma sugestão em andamento para este encarte.',
      details: { reason: 'IN_FLIGHT', retryAfterSeconds: 7 },
    });
    expect(
      bodyOf(flyerProStructureAiBusy({ reason: 'HOURLY_LIMIT', retryAfterSeconds: 1140 })),
    ).toEqual({
      status: 429,
      code: 'FLYER_PRO_STRUCTURE_AI_BUSY',
      message: 'Limite de sugestões por hora atingido.',
      details: { reason: 'HOURLY_LIMIT', retryAfterSeconds: 1140 },
    });
  });

  it.each(['PROVIDER_ERROR', 'TIMEOUT', 'INVALID_OUTPUT'] as const)(
    'FLYER_PRO_STRUCTURE_AI_FAILED: 503 com `reason` %s e o `suggestionId` em `details`',
    (reason) => {
      expect(bodyOf(flyerProStructureAiFailed({ reason, suggestionId: SUGGESTION_ID }))).toEqual({
        status: 503,
        code: 'FLYER_PRO_STRUCTURE_AI_FAILED',
        message: 'A sugestão não ficou pronta. Nada foi alterado.',
        details: { reason, suggestionId: SUGGESTION_ID },
      });
    },
  );

  it('FLYER_PRO_NO_ITEMS: 422 com `details` presente, para o filtro não repetir a mensagem', () => {
    expect(bodyOf(flyerProNoItems())).toEqual({
      status: 422,
      code: 'FLYER_PRO_NO_ITEMS',
      message: 'Não há itens do encarte neste pedido.',
      details: {},
    });
  });

  it('nenhuma das fábricas devolve erro sem `details` nem `issues` (risco de http-exception.filter.ts:65)', () => {
    const bodies = [
      flyerProStructureStateInvalid([{ field: 'sections', code: 'TOO_FEW_SECTIONS' }]),
      flyerProStructureAiDisabled('FLAG'),
      flyerProStructureAiBusy({ reason: 'IN_FLIGHT', retryAfterSeconds: 1 }),
      flyerProStructureAiFailed({ reason: 'TIMEOUT', suggestionId: SUGGESTION_ID }),
      flyerProNoItems(),
    ].map((error) => error.getResponse() as Record<string, unknown>);
    for (const body of bodies) {
      expect('details' in body || 'issues' in body).toBe(true);
    }
  });
});
