import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GalleryProductLinkService } from '../../gallery/gallery-product-link.service';
import { isHumanPhotoChange, PhotoChoice } from '../domain/flyer-pro-photo-choice';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import type { FlyerProLinkWarning } from '../views/flyer-pro-save.view';

type LinkWarningCode = FlyerProLinkWarning['code'];

/** O que o registro precisa depois da gravação: as escolhas, os itens como ficaram e o cliente do encarte. */
export interface RegisterPhotoChoices {
  choices: PhotoChoice[];
  items: FlyerProItem[];
  clientId: string | null;
}

/** O código do aviso de uma falha da Galeria: foto que não existe mais, ou qualquer outro erro. */
function warningCodeOf(error: unknown): LinkWarningCode {
  const notFound = error instanceof NotFoundException ? error.getResponse() : undefined;
  const code = (notFound as { code?: string } | undefined)?.code;
  return code === 'GALLERY_IMAGE_NOT_FOUND' ? 'GALLERY_IMAGE_NOT_FOUND' : 'GALLERY_LINK_FAILED';
}

/**
 * U2.7: depois do commit do `PATCH` (N4), grava na foto escolhida da Galeria o nome da planilha do item, o EAN dele e a
 * preferência do cliente do encarte (`GalleryProductLinkService.linkProduct`), com os valores de depois da gravação.
 * Uma falha nunca desfaz o salvar: vira um aviso por item, e as outras escolhas seguem.
 */
@Injectable()
export class FlyerProImageLinkService {
  private readonly logger = new Logger(FlyerProImageLinkService.name);

  constructor(private readonly gallery: GalleryProductLinkService) {}

  /** Um aviso por escolha que falhou, na ordem das escolhas; lista vazia quando nada falha. */
  async register({
    choices,
    items,
    clientId,
  }: RegisterPhotoChoices): Promise<FlyerProLinkWarning[]> {
    const warnings: FlyerProLinkWarning[] = [];
    for (const choice of choices.filter(isHumanPhotoChange)) {
      try {
        const item = items.find((candidate) => candidate.id === choice.itemId);
        await this.gallery.linkProduct(choice.galleryImageId, {
          productName: item.sourceName ?? item.name,
          ean: item.ean,
          clientId,
        });
      } catch (error) {
        const code = warningCodeOf(error);
        this.logger.warn(`Registro da foto do item ${choice.itemId} falhou: ${code}`);
        warnings.push({ itemId: choice.itemId, code });
      }
    }
    return warnings;
  }
}
