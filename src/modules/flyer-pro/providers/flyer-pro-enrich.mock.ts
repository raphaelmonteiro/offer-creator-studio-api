import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { fold } from '../../../shared/text/fold';
import type { EnrichStep } from '../domain/flyer-pro-job.types';
import { FlyerProGalleryPhotos, GalleryPhoto } from '../services/flyer-pro-gallery-photos';
import { FlyerProImageSizeService } from '../services/flyer-pro-image-size.service';
import { CATEGORY_WORDS, SPELLING_FIXES } from './flyer-pro-enrich.mock.words';
import type {
  CategoryVerdict,
  EnrichCallContext,
  EnrichItemInput,
  FlyerProEnrichPort,
  ImageCandidateVerdict,
  ImageVerdict,
  SpellVerdict,
} from './flyer-pro-enrich.port';

/** Quantas imagens da Galeria o simulado usa, as mais antigas. */
const GALLERY_POOL = 30;
/** Quanto o marcador `#ia-lenta` faz cada lote esperar. */
export const SLOW_MARKER_MS = 20_000;
const REASON = '[simulado]';
export const MOCK_MODEL = 'mock';

const upper = (text: string): string => fold(text).toUpperCase();

/** Hash estável (FNV-1a de 32 bits) do texto normalizado: o mesmo nome dá sempre o mesmo número. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of upper(text.trim())) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash;
}

const WORD_TO_CATEGORY = new Map<string, string>(
  Object.entries(CATEGORY_WORDS).flatMap(([category, words]) =>
    words.map((word): [string, string] => [word, category]),
  ),
);

/** A categoria da primeira palavra do nome que está na tabela, ou `null`. */
export function categoryOfName(name: string): { category: string; word: string } | null {
  for (const word of upper(name).split(/[^A-Z0-9]+/)) {
    const category = WORD_TO_CATEGORY.get(word);
    if (category) return { category, word };
  }
  return null;
}

/** O nome com as grafias conhecidas corrigidas, ou `null` se nenhuma palavra está na tabela. */
export function correctedName(name: string): string | null {
  let changed = false;
  const words = name.split(' ').map((word) => {
    const fix = SPELLING_FIXES[upper(word)];
    if (fix) changed = true;
    return fix ?? word;
  });
  return changed ? words.join(' ') : null;
}

type Marker = 'slow' | 'transient' | 'terminal';

/** Os marcadores do nome do encarte, sem diferença de maiúsculas; `#ia-falha-terminal` vence `#ia-falha`. */
function markersOf(documentName: string): Set<Marker> {
  const name = documentName.toLowerCase();
  const markers = new Set<Marker>();
  if (name.includes('#ia-lenta')) markers.add('slow');
  if (name.includes('#ia-falha-terminal')) markers.add('terminal');
  else if (name.includes('#ia-falha')) markers.add('transient');
  return markers;
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * O provedor simulado do job (A-15, A-16): determinístico pelo conteúdo do item, sem rede e sem custo. Categorias de uma
 * tabela de palavras, ortografia de uma tabela de grafias, fotos das primeiras 30 imagens da Galeria, divididas entre
 * "aplicada", "para revisar" e "não encontrada". Os marcadores no nome do encarte simulam falha e lentidão.
 */
export class MockFlyerProEnrich implements FlyerProEnrichPort {
  constructor(
    private readonly gallery: Pick<FlyerProGalleryPhotos, 'first'>,
    private readonly sizes: Pick<FlyerProImageSizeService, 'measure'>,
    private readonly sleep: Sleep = realSleep,
  ) {}

  isAvailable(_phase: EnrichStep): boolean {
    return true;
  }

  async categorize(
    items: EnrichItemInput[],
    context: EnrichCallContext,
  ): Promise<CategoryVerdict[]> {
    await this.slowDown(context);
    this.report(context);
    return items.map((item) => this.categoryOf(item));
  }

  async spellcheck(items: EnrichItemInput[], context: EnrichCallContext): Promise<SpellVerdict[]> {
    await this.slowDown(context);
    this.report(context);
    return items.map((item): SpellVerdict => {
      const value = correctedName(item.name);
      return value
        ? { itemId: item.id, action: 'suggest', value }
        : { itemId: item.id, action: 'clean' };
    });
  }

  async matchImages(items: EnrichItemInput[], context: EnrichCallContext): Promise<ImageVerdict[]> {
    const markers = markersOf(context.documentName);
    if (markers.has('slow')) await this.sleep(SLOW_MARKER_MS);
    this.report(context);
    if (markers.has('terminal'))
      throw new TerminalProviderError('[simulado] falha terminal', 'provider_auth');
    if (markers.has('transient')) throw new TransientProviderError('[simulado] falha transitória');
    const photos = await this.gallery.first(GALLERY_POOL);
    return Promise.all(items.map((item) => this.imageOf(item, photos)));
  }

  /**
   * O uso da chamada simulada: o modelo `"mock"` (vai para `models`) e uma chamada sem uso, que deixa o custo desconhecido
   * pela mesma regra do provedor real (`costUsd` nulo).
   */
  private report(context: EnrichCallContext): void {
    context.usage.declareModel(MOCK_MODEL);
    context.usage.record(MOCK_MODEL, null);
  }

  private async slowDown(context: EnrichCallContext): Promise<void> {
    if (markersOf(context.documentName).has('slow')) await this.sleep(SLOW_MARKER_MS);
  }

  private categoryOf(item: EnrichItemInput): CategoryVerdict {
    const found = categoryOfName(item.name);
    if (!found) return { itemId: item.id, action: 'none' };
    const known = item.category !== null && item.category !== undefined;
    if (known && upper(item.category as string) === upper(found.category)) {
      return { itemId: item.id, action: 'none' };
    }
    return {
      itemId: item.id,
      action: known ? 'suggest' : 'apply',
      category: found.category,
      confidence: 0.9,
      why: `${REASON} palavra "${found.word}"`,
    };
  }

  private async imageOf(item: EnrichItemInput, photos: GalleryPhoto[]): Promise<ImageVerdict> {
    if (photos.length === 0) return { itemId: item.id, action: 'not_found' };
    const hash = stableHash(item.sourceName ?? item.name);
    const outcome = hash % 3;
    if (outcome === 2) return { itemId: item.id, action: 'not_found' };
    const first = hash % photos.length;
    if (outcome === 1)
      return { itemId: item.id, action: 'review', candidates: candidatesFrom(photos, first) };
    const picked = candidatesFrom(photos, first, 1)[0];
    const size = await this.sizes.measure(picked.url);
    // Arquivo que não abre: a foto vai para revisão como candidata, nunca aplicada sem medida (D-2 (a)).
    if (!size) return { itemId: item.id, action: 'review', candidates: [picked] };
    return { itemId: item.id, action: 'apply', photo: { ...picked, ...size } };
  }
}

/** Até `count` fotos a partir de `first`, em círculo, sem repetir; a primeira tem o melhor `score`. */
function candidatesFrom(photos: GalleryPhoto[], first: number, count = 3): ImageCandidateVerdict[] {
  const total = Math.min(count, photos.length);
  return Array.from({ length: total }, (_, offset): ImageCandidateVerdict => {
    const photo = photos[(first + offset) % photos.length];
    return {
      galleryImageId: photo.id,
      url: photo.url,
      thumbnailUrl: photo.thumbnailUrl ?? null,
      score: Math.round((0.85 - offset * 0.1) * 100) / 100,
      reasons: [`${REASON} foto da Galeria`],
      isClientPreferred: false,
    };
  });
}
