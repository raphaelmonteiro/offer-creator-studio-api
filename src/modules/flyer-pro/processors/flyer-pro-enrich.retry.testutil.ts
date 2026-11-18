import type {
  EnrichCallContext,
  EnrichItemInput,
  FlyerProEnrichPort,
  ImageVerdict,
} from '../providers/flyer-pro-enrich.port';

/** Uma chamada da busca de fotos ao provedor de roteiro: a passada (0 é a fase de fotos) e os itens do lote. */
export interface PhotoCall {
  pass: number;
  names: string[];
}

export const photoOf = (id: string) => ({
  galleryImageId: '00000000-0000-4000-8000-000000000001',
  url: `http://localhost:3101/uploads/gallery/${id}.jpg`,
  thumbnailUrl: null,
  score: 0.9,
  reasons: ['EAN igual'],
  isClientPreferred: false,
  width: 600,
  height: 1200,
});

export const applied = (itemId: string): ImageVerdict => ({
  itemId,
  action: 'apply',
  photo: photoOf(itemId),
  eanStatus: 'gallery',
});
export const pending = (itemId: string): ImageVerdict => ({
  itemId,
  action: 'pending',
  candidates: [],
});

/**
 * Um provedor de roteiro só para a fase de fotos: `script` decide o veredito de cada item pelo número da passada. Registra
 * as chamadas; categorias e ortografia nunca são pedidas nestes testes.
 */
export function scriptedPort(
  script: (
    item: EnrichItemInput,
    context: EnrichCallContext,
  ) => ImageVerdict | Promise<ImageVerdict>,
  options: { delayMs?: number } = {},
) {
  const calls: PhotoCall[] = [];
  const port: FlyerProEnrichPort = {
    isAvailable: () => true,
    categorize: async () => [],
    spellcheck: async () => [],
    matchImages: async (items, context) => {
      calls.push({ pass: context.pass, names: items.map((item) => item.name) });
      context.usage.declareModel('roteiro');
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return Promise.all(items.map((item) => script(item, context)));
    },
  };
  return { port, calls };
}
