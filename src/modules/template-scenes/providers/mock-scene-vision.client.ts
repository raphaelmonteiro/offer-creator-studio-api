import type { VisionCompareInput, VisionCompareResult } from '../../ai/openai-vision.service';

/** Marcadores no pedido que simulam falha da visão. */
export const MOCK_VISION_MARKERS = {
  fail: '#falha-visao',
  invalidJson: '#visao-invalida',
  /** A visão responde que o pedido não foi atendido (`atendeu: nao`), para exercitar a tela sem custo. */
  notSatisfied: '#visao-nao',
} as const;

/**
 * Visão de desenvolvimento: sem rede e sem custo. Responde um JSON fixo, e os marcadores
 * `#falha-visao` e `#visao-invalida` exercitam a queda para a resposta pelas métricas, e `#visao-nao` faz a
 * visão dizer que o pedido não foi atendido (a imagem atual fica e a tentativa vira "Não aplicada").
 */
export class MockSceneVisionClient {
  async compare(input: VisionCompareInput): Promise<VisionCompareResult> {
    if (input.prompt.includes(MOCK_VISION_MARKERS.fail))
      throw new Error('Mock: visão indisponível');
    return {
      text: this.answer(input.prompt),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      requestId: 'mock-vision',
      latencyMs: 0,
    };
  }

  private answer(prompt: string): string {
    if (prompt.includes(MOCK_VISION_MARKERS.invalidJson)) return 'não é json';
    if (prompt.includes(MOCK_VISION_MARKERS.notSatisfied)) {
      return JSON.stringify({ mudou: 'Não vi o que foi pedido na imagem.', atendeu: 'nao' });
    }
    return JSON.stringify({ mudou: 'Alterei a área marcada, como pedido.', atendeu: 'sim' });
  }
}
