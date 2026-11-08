import { createHash } from 'crypto';
import { SceneElement } from './scene.types';

/** Sobe quando o algoritmo da projeção muda: invalida a impressão digital de todos os templates de cena. */
export const PROJECTION_VERSION = 1;

/** JSON com as chaves em ordem, para o mesmo conteúdo dar sempre o mesmo texto. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sha1 = (value: unknown): string =>
  createHash('sha1').update(canonicalJson(value)).digest('hex');

const byLayerOrder = (a: SceneElement, b: SceneElement): number =>
  a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Elementos que entram na imagem achatada (PNG transparente com arquivo da própria cena). */
export const isFlattened = (element: SceneElement): boolean =>
  element.kind === 'generated' && Boolean(element.assetId);

/** Camadas que viram `elements` do template: logo e texto. */
export const isLayer = (element: SceneElement): boolean =>
  element.kind === 'logo' || element.kind === 'text';

export interface ProjectionKeysInput {
  formatId: string;
  name: string;
  masterAssetId: string;
  elements: SceneElement[];
}

export interface ProjectionKeys {
  /** Muda só quando a imagem do template muda (master, elementos achatados, formato). */
  pictorialKey: string;
  /** Muda com qualquer coisa do template (imagem, camadas, nome). */
  fingerprint: string;
}

/** As duas impressões digitais de PV-12 (sha-1 de JSON canônico mais `PROJECTION_VERSION`). */
export function projectionKeys(input: ProjectionKeysInput): ProjectionKeys {
  const flattened = input.elements
    .filter(isFlattened)
    .sort(byLayerOrder)
    .map(({ assetId, x, y, w, aspect, rotation, z }) => ({
      assetId,
      x,
      y,
      w,
      aspect,
      rotation,
      z,
    }));
  const pictorialKey = sha1({
    version: PROJECTION_VERSION,
    format: input.formatId,
    master: input.masterAssetId,
    flattened,
  });
  const layers = input.elements.filter(isLayer).sort(byLayerOrder);
  return { pictorialKey, fingerprint: sha1({ pictorialKey, layers, name: input.name }) };
}
