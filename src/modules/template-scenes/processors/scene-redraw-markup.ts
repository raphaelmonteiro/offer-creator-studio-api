import { renderMarkup } from '../domain/scene-markup';
import { Rect } from '../domain/scene.types';
import { markingOf } from '../services/scene-director-context';
import { TurnContext } from './scene-turn-context';

/** A marcação da versão já desenhada em PNG, e o que dela fica no registro de auditoria. */
export interface MarkupInfo {
  png: Buffer;
  kind: 'retângulo' | 'pincel' | 'laço';
  box: Rect;
}

/**
 * `markup` do pedido: só existe quando o cliente marcou (retângulo, zona, pincel ou laço). O código nunca gera
 * marcação sozinho (D4), e `targetElementId` não é marcação. O PNG tem o tamanho da imagem enviada.
 */
export async function markupFor(
  ctx: Pick<TurnContext, 'requestedRegion' | 'requestedMask' | 'zones'>,
  size: { width: number; height: number },
): Promise<MarkupInfo | null> {
  const marking = markingOf(ctx, size.height / size.width);
  if (!marking) return null;
  const spec = ctx.requestedMask ?? { kind: 'rect' as const, rect: marking.box };
  const png = await renderMarkup(spec, size.width, size.height, ctx.zones);
  return { png, kind: marking.kind, box: marking.box };
}
