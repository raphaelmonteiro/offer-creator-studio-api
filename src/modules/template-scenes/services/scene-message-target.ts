import { SendMessageDto } from '../dto/send-message.dto';
import { MIN_SHAPE_AREA_RATIO } from '../domain/scene-mask-shape';
import { rasterizeRegion, shapeAreaRatio } from '../domain/scene-shapes';
import { TemplateScene } from '../entities/template-scene.entity';
import { invalidBody, regionTooSmall } from '../scene.errors';

/** Conferência do alvo da mensagem (400 e 422), antes de qualquer consulta ao banco ou ao Diretor. */

const TARGET_KEYS = ['region', 'mask', 'zone', 'targetElementId'] as const;

/** A confirmação vem sozinha: com alvo ou anexo é 400, e a pergunta segue pendente. */
function assertConfirmationAlone(dto: SendMessageDto, given: readonly string[]): void {
  if (!dto.confirmGlobal) return;
  if (!dto.replyToMessageId) {
    throw invalidBody('Para confirmar o ajuste geral, envie também replyToMessageId.');
  }
  if (given.length > 0 || (dto.attachments?.length ?? 0) > 0) {
    throw invalidBody(
      'Confirmar o ajuste geral não aceita área, zona, elemento nem anexo: envie só a confirmação.',
    );
  }
}

/** Região, máscara, zona e elemento são alvos exclusivos (400, nada é gravado). */
export function assertSingleTarget(dto: SendMessageDto): void {
  const given = TARGET_KEYS.filter((key) => dto[key] !== undefined && dto[key] !== null);
  if (given.length > 1) {
    throw invalidBody(`Envie um alvo só: ${given.join(', ')} não podem vir juntos.`);
  }
  assertConfirmationAlone(dto, given);
  if (
    dto.region &&
    (dto.region.x + dto.region.w > 1.0001 || dto.region.y + dto.region.h > 1.0001)
  ) {
    throw invalidBody('A região passa da borda da imagem.');
  }
}

/** Área da forma acima de 0,1% da cena; o retângulo é conferido na conta, o pincel e o laço rasterizados. */
export async function assertShapeBigEnough(
  dto: SendMessageDto,
  scene: TemplateScene,
): Promise<void> {
  if (dto.region) {
    if (dto.region.w * dto.region.h < MIN_SHAPE_AREA_RATIO) throw regionTooSmall();
    return;
  }
  if (!dto.mask) return;
  const width = 256;
  const height = Math.max(1, Math.round((width * scene.heightPx) / scene.widthPx));
  const shape = await rasterizeRegion(dto.mask, width, height);
  if (shapeAreaRatio(shape) < MIN_SHAPE_AREA_RATIO) throw regionTooSmall();
}
