import { fold } from '../../../shared/text/fold';
import { SceneElement } from './scene.types';

const STOP_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'uma', 'um']);

/** Palavras significativas do nome da camada: 4 letras ou mais, sem as de ligação (PV-35, D-21). */
export const nameWords = (name: string): string[] =>
  fold(name)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

/** O texto cita o nome da camada (alguma palavra significativa dele)? `folded` já vem dobrado. */
export function layerNamedIn(layer: SceneElement, folded: string): boolean {
  return nameWords(layer.name).some((word) => new RegExp(`\\b${word}`).test(folded));
}
