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
  /** O juiz vê texto que ninguém pediu (D-51; substitui `#juiz-texto`). */
  extraText: '#juiz-texto-extra',
  /** O juiz lê o texto sem o acento na primeira chamada e certo na segunda (a refação acerta). */
  textWrong: '#juiz-texto-errado',
  /** O juiz lê o texto errado nas duas chamadas (a refação não resolve). `#juiz-texto-errado` não o contém. */
  textWrongTwice: '#juiz-texto-errado-2',
  /** O juiz não acha o texto na imagem. */
  textEmpty: '#juiz-texto-vazio',
  /** O juiz vê emenda ou objeto flutuando (D-44): o chat avisa, sem refazer e sem mudar o veredito. */
  seam: '#juiz-emenda',
} as const;

/** Linhas esperadas do prompt do juiz (`Linha 1: “...”`). */
function expectedLines(prompt: string): string[] {
  return [...prompt.matchAll(/^Linha \d+: “(.*)”$/gm)].map((match) => match[1]);
}

/** O texto como o modelo de imagem o erraria: sem acento e sem cedilha. */
const misread = (line: string): string => line.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Ids da lista do que o cliente pediu que vêm no prompt do juiz (`- p1: texto`). */
function openIds(prompt: string): string[] {
  return [...prompt.matchAll(/^- (p\d+): /gm)].map((match) => match[1]);
}

/**
 * Juiz de desenvolvimento: sem rede e sem custo. Responde `sim` e diz que viu todos os pedidos em aberto, lê o
 * texto esperado certo, e os marcadores `#juiz-nao`, `#juiz-parcial`, `#juiz-texto-errado`, `#juiz-texto-errado-2`,
 * `#juiz-texto-vazio`, `#juiz-texto-extra`, `#juiz-emenda`, `#juiz-falha` e `#juiz-invalido` exercitam as saídas e as
 * falhas. O marcador vem da mensagem do cliente, que o prompt traz literal.
 */
export class MockSceneVisionClient {
  /** Quantas vezes cada versão já pediu leitura: `#juiz-texto-errado` erra só na primeira. */
  private readonly readings = new Map<string, number>();

  async compare(input: VisionCompareInput): Promise<VisionCompareResult> {
    if (input.prompt.includes(MOCK_VISION_MARKERS.fail)) {
      throw new Error('Mock: juiz indisponível');
    }
    return {
      text: this.answer(input.prompt, this.nextReading(input.correlationId)),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      requestId: 'mock-vision',
      latencyMs: 0,
    };
  }

  private nextReading(key: string): number {
    const count = (this.readings.get(key) ?? 0) + 1;
    this.readings.set(key, count);
    return count;
  }

  /** O que o juiz "lê" de cada linha esperada, segundo o marcador e a ordem da leitura. */
  private readText(prompt: string, reading: number): Array<{ pedido: string; lido: string }> {
    const has = (marker: string): boolean => prompt.includes(marker);
    return expectedLines(prompt).map((line) => {
      const wrong =
        has(MOCK_VISION_MARKERS.textWrongTwice) ||
        (has(MOCK_VISION_MARKERS.textWrong) && reading === 1);
      if (has(MOCK_VISION_MARKERS.textEmpty)) return { pedido: line, lido: '' };
      return { pedido: line, lido: wrong ? misread(line) : line };
    });
  }

  private answer(prompt: string, reading: number): string {
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
      faltou: '',
      texto_lido: this.readText(prompt, reading),
      texto_extra: has(MOCK_VISION_MARKERS.extraText) ? 'PROMO' : '',
      emenda: has(MOCK_VISION_MARKERS.seam),
      emenda_descricao: has(MOCK_VISION_MARKERS.seam)
        ? 'grupo sobre uma faixa de grama flutuando'
        : '',
    });
  }
}
