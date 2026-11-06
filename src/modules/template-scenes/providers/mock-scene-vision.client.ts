import type { VisionCompareInput, VisionCompareResult } from '../../ai/openai-vision.service';

/** Marcadores na mensagem que simulam o juiz (D-26: o resultado é aplicado em todos os casos). */
export const MOCK_VISION_MARKERS = {
  /** O juiz falha (erro do provedor): a resposta diz que não conseguiu conferir. */
  fail: '#juiz-falha',
  invalidJson: '#juiz-invalido',
  /** O juiz responde `nao`: o pedido não aparece atendido, e a tela oferece "Voltar para a anterior". */
  notSatisfied: '#juiz-nao',
  /** O juiz responde `parcial`. */
  partial: '#juiz-parcial',
  /** O juiz vê texto pintado na imagem nova. */
  text: '#juiz-texto',
  /** O juiz vê emenda ou objeto flutuando (D-44): o chat avisa, sem refazer e sem mudar o veredito. */
  seam: '#juiz-emenda',
} as const;

/** Ids da lista do que o cliente pediu que vêm no prompt do juiz (`- p1: texto`). */
function openIds(prompt: string): string[] {
  return [...prompt.matchAll(/^- (p\d+): /gm)].map((match) => match[1]);
}

/**
 * Juiz de desenvolvimento: sem rede e sem custo. Responde `sim` e diz que viu todos os pedidos em aberto, e os
 * marcadores `#juiz-nao`, `#juiz-parcial`, `#juiz-texto`, `#juiz-emenda`, `#juiz-falha` e `#juiz-invalido` exercitam as saídas e as
 * falhas. O marcador vem da mensagem do cliente, que o prompt traz literal.
 */
export class MockSceneVisionClient {
  async compare(input: VisionCompareInput): Promise<VisionCompareResult> {
    if (input.prompt.includes(MOCK_VISION_MARKERS.fail)) {
      throw new Error('Mock: juiz indisponível');
    }
    return {
      text: this.answer(input.prompt),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      requestId: 'mock-vision',
      latencyMs: 0,
    };
  }

  private answer(prompt: string): string {
    if (prompt.includes(MOCK_VISION_MARKERS.invalidJson)) return 'não é json';
    const ids = openIds(prompt);
    const has = (marker: string): boolean => prompt.includes(marker);
    const satisfied = has(MOCK_VISION_MARKERS.notSatisfied)
      ? 'nao'
      : has(MOCK_VISION_MARKERS.partial)
        ? 'parcial'
        : 'sim';
    const missed = satisfied !== 'sim';
    return JSON.stringify({
      atendeu: satisfied,
      mudou: missed ? 'Não vi o que foi pedido na imagem.' : 'Alterei a imagem, como pedido.',
      vistos: missed ? [] : ids,
      nao_vistos: missed ? ids : [],
      texto_na_imagem: has(MOCK_VISION_MARKERS.text),
      emenda: has(MOCK_VISION_MARKERS.seam),
      emenda_descricao: has(MOCK_VISION_MARKERS.seam)
        ? 'grupo sobre uma faixa de grama flutuando'
        : '',
    });
  }
}
