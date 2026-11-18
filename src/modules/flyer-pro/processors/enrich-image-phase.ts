import type { FlyerEanResolutionService } from '../../ai/ean/dotcompany/flyer-ean-resolution.service';
import type { GalleryEmbeddingService } from '../../ai/gallery-embedding.service';
import {
  ImageSearchAnswer,
  imageSearchRequest,
  imageVerdictOf,
  PhotoSize,
} from '../domain/flyer-pro-enrich-image';
import type {
  EnrichCallContext,
  EnrichItemInput,
  ImageVerdict,
} from '../providers/flyer-pro-enrich.port';
import type { FlyerProImageSizeService } from '../services/flyer-pro-image-size.service';

/** O que a fase usa da busca de fotos do encarte (`FlyerEanResolutionService`). */
export type ImageSearchApi = Pick<FlyerEanResolutionService, 'findImages'>;
/** A busca por nome depende do embedding: é ele que diz se ela está disponível. */
export type NameSearchApi = Pick<GalleryEmbeddingService, 'isEnabled'>;
export type PhotoSizeApi = Pick<FlyerProImageSizeService, 'measure'>;

/**
 * A fase de fotos do provedor real (U2.6): chama a busca de fotos do encarte (EAN, nome já escolhido e casamento por
 * nome) no modo estrito, com o cliente do encarte e pedindo o uso da leitura do nome. A fase nunca é pulada: o EAN da
 * Galeria e o nome já escolhido não dependem da IA; sem a busca por nome (embedding desligado ou sem chave), roda só com
 * eles e conta o fato no lote. A medida da foto vem do arquivo (dentro do prazo do lote); sem medida, a foto vai para
 * revisão. A foto do job não é registrada na Galeria (A-02-16).
 */
export class EnrichImagePhase {
  constructor(
    private readonly images: ImageSearchApi,
    private readonly nameSearch: NameSearchApi,
    private readonly sizes: PhotoSizeApi,
  ) {}

  async run(items: EnrichItemInput[], context: EnrichCallContext): Promise<ImageVerdict[]> {
    const nameSearch = this.nameSearch.isEnabled();
    context.notes.nameSearchUnavailable = !nameSearch;
    const answer: ImageSearchAnswer = await this.images.findImages(
      imageSearchRequest(items),
      context.clientId,
      { strict: true, usage: context.usage, signal: context.signal },
    );
    const sizes = await this.measureMatches(answer, context.signal);
    return items.map((item) => imageVerdictOf(item, answer, { sizes, nameSearch }));
  }

  /** A medida de cada foto de `matches`, em paralelo (só o cabeçalho do arquivo); `null` onde não deu para ler. */
  private async measureMatches(
    answer: ImageSearchAnswer,
    signal: AbortSignal,
  ): Promise<Map<string, PhotoSize | null>> {
    const measured = await Promise.all(
      answer.matches.map(
        async (match): Promise<[string, PhotoSize | null]> => [
          match.productId,
          await this.sizes.measure(match.imageUrl, { signal }),
        ],
      ),
    );
    return new Map(measured);
  }
}
