import { findFlyerProFormat, sceneFormatIdOf } from './flyer-pro-formats';
import { flyerProFoldLocked, flyerProPageCountInvalid } from './flyer-pro.errors';
import type { FlyerProFormat } from './flyer-pro.types';

/** As regras do ramo `setup` do `PATCH` que não leem o banco: qual cena montar, a dobra travada e o número de páginas. */

interface SetupScene {
  sceneId?: string | null;
  refreshTemplate?: boolean | null;
}

/**
 * A cena de que o servidor remonta a cópia: `setup.sceneId`, ou a cena atual com `refreshTemplate: true`. Com os dois
 * no mesmo corpo vale o `sceneId`; `refreshTemplate: false` não remonta nada (A-7). `undefined`: não remonta.
 */
export function sceneToBuild(document: { sceneId: string }, setup: SetupScene): string | undefined {
  if (setup.sceneId) return setup.sceneId;
  return setup.refreshTemplate === true ? document.sceneId : undefined;
}

/** Com as páginas congeladas, trocar para um template de outro formato é 422; do mesmo formato é permitido. */
export function assertFoldNotLocked(
  document: { format: FlyerProFormat; pagesFrozen: boolean },
  newFormat: FlyerProFormat,
): void {
  if (document.pagesFrozen && newFormat !== document.format) {
    throw flyerProFoldLocked({ format: document.format, newFormat });
  }
}

/**
 * O `pageCount` a gravar, ou `undefined` para deixar o atual. Se o formato mudou e o corpo não trouxe páginas, volta ao
 * padrão do formato novo (PU-20); o que o corpo trouxe é conferido contra as opções do formato resultante.
 */
export function resolvePageCount(input: {
  format: FlyerProFormat;
  formatChanged: boolean;
  requested?: number | null;
}): number | undefined {
  const { format, formatChanged, requested } = input;
  const spec = findFlyerProFormat(sceneFormatIdOf(format));
  if (requested === undefined || requested === null) {
    return formatChanged ? spec.defaultPageCount : undefined;
  }
  if (!spec.pageOptions.includes(requested)) {
    throw flyerProPageCountInvalid({ format, allowed: [...spec.pageOptions] });
  }
  return requested;
}
