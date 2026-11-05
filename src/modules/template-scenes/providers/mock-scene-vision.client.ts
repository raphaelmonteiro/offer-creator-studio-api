import type { VisionCompareInput, VisionCompareResult } from '../../ai/openai-vision.service';

/** Marcadores no pedido que simulam falha da visão. */
export const MOCK_VISION_MARKERS = {
  fail: '#falha-visao',
  invalidJson: '#visao-invalida',
} as const;

/**
 * Visão de desenvolvimento: sem rede e sem custo. Responde um JSON fixo, e os marcadores
 * `#falha-visao` e `#visao-invalida` exercitam a queda para a resposta pelas métricas.
 */
export class MockSceneVisionClient {
  async compare(input: VisionCompareInput): Promise<VisionCompareResult> {
    if (input.prompt.includes(MOCK_VISION_MARKERS.fail))
      throw new Error('Mock: visão indisponível');
    const text = input.prompt.includes(MOCK_VISION_MARKERS.invalidJson)
      ? 'não é json'
      : JSON.stringify({ mudou: 'Alterei a área marcada, como pedido.', atendeu: 'sim' });
    return { text, usage: null, requestId: 'mock-vision', latencyMs: 0 };
  }
}
