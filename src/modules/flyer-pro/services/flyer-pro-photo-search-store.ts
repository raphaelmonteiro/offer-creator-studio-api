import type { PhotoSearchResult } from '../providers/flyer-pro-photo-search.port';

/** A resposta de uma busca vale 24 horas, conferidas na leitura (D-7). */
export const PHOTO_SEARCH_TTL_MS = 24 * 3_600_000;
/** No máximo 2.000 páginas guardadas no processo, somados todos os encartes (D-orq-256). */
export const PHOTO_SEARCH_MAX_PAGES = 2_000;

/** Onde uma página mora: encarte, item, termo (como o operador mandou) e página. */
export interface PhotoPageScope {
  documentId: string;
  itemId: string;
  term: string;
  page: number;
}

/** Um resultado guardado: o do provedor, com o `resultId` que a tela devolve no download. */
export interface StoredPhotoResult extends PhotoSearchResult {
  resultId: string;
}

/** O que se guarda de uma página: os resultados já filtrados e se há página seguinte. */
export interface StoredPhotoPage {
  hasMore: boolean;
  results: StoredPhotoResult[];
}

interface Entry extends StoredPhotoPage {
  documentId: string;
  itemId: string;
  termKey: string;
  page: number;
  /** Instante (ms) da gravação. */
  at: number;
}

/** O termo da chave: aparado, com os espaços internos juntos e em minúsculas (a Serper não distingue caixa, D-orq-256). */
const termKeyOf = (term: string): string => term.trim().replace(/\s+/g, ' ').toLowerCase();

const pageKeyOf = (scope: PhotoPageScope): string =>
  [scope.documentId, scope.itemId, termKeyOf(scope.term), scope.page].join('|');

/**
 * A memória da API com as respostas da busca de fotos por encarte, item, termo e página, e os pedidos iguais no ar. É por
 * processo e zera quando a API reinicia (um `resultId` de antes do reinício nunca é achado). Quem escreve decide o que é
 * página nova; aqui só se guarda, se confere a validade e se mantém o teto de páginas.
 */
export class FlyerProPhotoSearchStore {
  /** Chave da página -> a página, da gravação mais antiga para a mais nova (a ordem de inserção do `Map`). */
  private readonly pages = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Contador dos `resultId`: começa no instante da subida e só cresce (A-27). */
  private lastId: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastId = this.now();
  }

  /** Quantas páginas a memória segura agora (vencidas que ainda não saíram inclusive); nunca passa de 2.000. */
  get pageCount(): number {
    return this.pages.size;
  }

  /** A página guardada e ainda válida, ou `null` (nunca buscada, vencida, expulsa pelo teto ou de outro encarte, item ou termo). */
  read(scope: PhotoPageScope): StoredPhotoPage | null {
    const entry = this.pages.get(pageKeyOf(scope));
    if (!entry || !this.isLive(entry, this.now())) return null;
    return { hasMore: entry.hasMore, results: entry.results };
  }

  /**
   * Guarda a página (e dá o `resultId` a cada resultado). Com a memória cheia, saem primeiro as vencidas e, se ainda cheia, a de
   * gravação mais antiga, nunca a que está sendo guardada. A página que saiu vale como vencida.
   */
  write(
    scope: PhotoPageScope,
    page: { hasMore: boolean; results: PhotoSearchResult[] },
  ): StoredPhotoPage {
    const key = pageKeyOf(scope);
    this.pages.delete(key);
    this.makeRoom();
    const stored: Entry = {
      documentId: scope.documentId,
      itemId: scope.itemId,
      termKey: termKeyOf(scope.term),
      page: scope.page,
      at: this.now(),
      hasMore: page.hasMore,
      results: page.results.map((result) => ({ ...result, resultId: this.nextResultId() })),
    };
    this.pages.set(key, stored);
    return { hasMore: stored.hasMore, results: stored.results };
  }

  /** O resultado do item, em qualquer termo e página ainda válidos do encarte; `null` para outro item, vencido ou inventado. */
  findResult(documentId: string, itemId: string, resultId: string): StoredPhotoResult | null {
    const now = this.now();
    for (const entry of this.pages.values()) {
      if (entry.documentId !== documentId || entry.itemId !== itemId || !this.isLive(entry, now))
        continue;
      const found = entry.results.find((result) => result.resultId === resultId);
      if (found) return found;
    }
    return null;
  }

  /** Os `imageUrl` das páginas anteriores do mesmo item e termo que ainda estão guardadas (A-29). */
  previousUrls(scope: PhotoPageScope): Set<string> {
    const now = this.now();
    const termKey = termKeyOf(scope.term);
    const urls = new Set<string>();
    for (const entry of this.pages.values()) {
      const sameSearch =
        entry.documentId === scope.documentId &&
        entry.itemId === scope.itemId &&
        entry.termKey === termKey;
      if (!sameSearch || entry.page >= scope.page || !this.isLive(entry, now)) continue;
      entry.results.forEach((result) => urls.add(result.imageUrl));
    }
    return urls;
  }

  /** Pedidos iguais (encarte, item, termo e página) no ar viram uma execução só: o segundo recebe a promessa do primeiro. */
  joinInFlight<T>(scope: PhotoPageScope, work: () => Promise<T>): Promise<T> {
    const key = pageKeyOf(scope);
    const running = this.inFlight.get(key);
    if (running) return running as Promise<T>;
    const started = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  private isLive(entry: Entry, now: number): boolean {
    return now - entry.at < PHOTO_SEARCH_TTL_MS;
  }

  private nextResultId(): string {
    this.lastId += 1;
    return `r${this.lastId}`;
  }

  /** Abre vaga para uma página nova: as vencidas saem primeiro e, se ainda cheia, a mais antiga. */
  private makeRoom(): void {
    if (this.pages.size < PHOTO_SEARCH_MAX_PAGES) return;
    const now = this.now();
    for (const [key, entry] of this.pages) {
      if (!this.isLive(entry, now)) this.pages.delete(key);
    }
    while (this.pages.size >= PHOTO_SEARCH_MAX_PAGES) {
      const oldest = this.pages.keys().next();
      if (oldest.done) return;
      this.pages.delete(oldest.value);
    }
  }
}
