import type { FlyerProTemplateFace, FlyerProTemplateStatus } from './flyer-pro.types';

type KeyedFace = Pick<FlyerProTemplateFace, 'key' | 'pictorialKey' | 'fingerprint'>;

/**
 * Compara a cópia guardada no encarte com a cena de hoje, face a face pela `key`, só por `pictorialKey` e
 * `fingerprint`. Nunca olha a `revision` da cena: ela sobe em toda mensagem do chat, mesmo sem imagem nova.
 *
 * - `art`: algum `pictorialKey` mudou, ou o conjunto de faces prontas mudou (A-5: face que sumiu ou apareceu);
 * - `layers`: só o `fingerprint` mudou (camada ou nome);
 * - `art` prevalece sobre `layers`.
 */
export function compareFaces(
  copy: KeyedFace[],
  today: KeyedFace[],
): Pick<FlyerProTemplateStatus, 'stale' | 'staleKind'> {
  const current = new Map(today.map((face) => [face.key, face]));
  const sameSet = copy.length === today.length && copy.every((face) => current.has(face.key));
  const pairs = sameSet ? copy.map((face) => [face, current.get(face.key) as KeyedFace]) : [];
  const art = !sameSet || pairs.some(([before, now]) => before.pictorialKey !== now.pictorialKey);
  const layers = pairs.some(([before, now]) => before.fingerprint !== now.fingerprint);
  if (art) return { stale: true, staleKind: 'art' };
  return layers ? { stale: true, staleKind: 'layers' } : { stale: false, staleKind: null };
}
