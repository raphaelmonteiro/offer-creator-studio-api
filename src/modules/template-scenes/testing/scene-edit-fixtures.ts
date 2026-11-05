import { LocalTarget, SceneClassification } from '../domain/scene-operation.classifier';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { useProcessorHarness } from './scene-processor-harness';

export const RECT = { x: 0.35, y: 0.3, w: 0.3, h: 0.15 };
export const editPlan = (
  target: LocalTarget = { kind: 'rect', rect: RECT },
  over: Partial<Extract<SceneClassification, { operation: 'local_edit' }>> = {},
): SceneClassification => ({
  operation: 'local_edit',
  target,
  instruction: 'deixa o sol mais alaranjado',
  remove: false,
  ...over,
});

export const goodVision = (): SceneVisionClient & { compare: jest.Mock } => ({
  compare: jest.fn(async () => ({
    text: JSON.stringify({ mudou: 'O sol ficou alaranjado.', atendeu: 'sim' }),
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
    requestId: 'req_v',
    latencyMs: 10,
  })),
});

/** Provedor que usa a edição do mock (pinta de verdade) mas cobra um valor conhecido. */
export const pricedProviderOf = (h: ReturnType<typeof useProcessorHarness>, costUsd = 0.035) => {
  const real = h.mock();
  return h.fakeProvider(() => h.okResult(), {
    edit: async (input) => ({ ...(await real.edit(input)), costUsd, requestId: 'req_edit' }),
  });
};
