import { SceneVisionClient } from '../providers/scene-vision-client';

/** Uma linha de `texto_lido` do juiz: o pedido e o que ele leu na imagem. */
export interface ReadEntry {
  pedido: string;
  lido: string;
}

/**
 * Juiz simulado que devolve uma leitura de texto por chamada, na ordem; a última se repete. `extra` sobrescreve
 * campos da resposta (`atendeu`, `vistos`, `nao_vistos`...).
 */
export function visionReadings(
  calls: ReadEntry[][],
  extra: Record<string, unknown> = {},
): { client: SceneVisionClient; compare: jest.Mock } {
  let call = 0;
  const compare = jest.fn(async () => {
    const reading = calls[Math.min(call, calls.length - 1)];
    call += 1;
    return {
      text: JSON.stringify({
        atendeu: 'sim',
        mudou: 'A placa apareceu.',
        vistos: [],
        nao_vistos: [],
        faltou: '',
        texto_lido: reading,
        texto_extra: '',
        emenda: false,
        emenda_descricao: '',
        ...extra,
      }),
      usage: { prompt_tokens: 3000, completion_tokens: 200 },
      requestId: 'req_judge',
      latencyMs: 500,
    };
  });
  return { client: { compare } as SceneVisionClient, compare };
}

/** O prompt de texto que o juiz recebeu na chamada `index` (a primeira por padrão). */
export const judgePromptOf = (compare: jest.Mock, index = 0): string =>
  (compare.mock.calls[index] as unknown as Array<{ prompt: string }>)[0].prompt;
