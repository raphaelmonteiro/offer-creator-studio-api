/**
 * Peças puras do roteiro do mascote (spike §4): extração das ofertas reais do
 * documento do encarte e estimativa de duração da locução.
 *
 * Fica fora do service para poder ser testado sem OpenAI, sem banco e sem Nest.
 */

import { priceToWordsPtBr } from './price-to-words.util';

export interface MascotScriptProduct {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  unit?: string;
  category?: string;
  /** Preço já por extenso, pronto para o TTS. */
  priceSpelled: string;
}

/**
 * Velocidade de locução em pt-BR (spike §3.5/§4). O intervalo real de um
 * locutor de varejo é 14–16 caracteres por segundo; usamos o meio para
 * estimar e o extremo lento para avisar antes de gastar TTS.
 */
export const PT_BR_CHARS_PER_SECOND = 15;
export const PT_BR_CHARS_PER_SECOND_RANGE = [14, 16] as const;

/** Estimativa de duração da fala, em segundos, com 1 casa decimal. */
export function estimateSpeechSeconds(
  text: string,
  charsPerSecond = PT_BR_CHARS_PER_SECOND,
): number {
  const normalized = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) return 0;
  return Math.round((normalized.length / charsPerSecond) * 10) / 10;
}

/** Quantos caracteres cabem em `seconds` no ritmo mais LENTO (pior caso). */
export function charBudgetForSeconds(seconds: number): number {
  return Math.max(0, Math.floor(seconds * PT_BR_CHARS_PER_SECOND_RANGE[0]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toProduct(
  source: Record<string, unknown>,
  fallbackId: string,
): MascotScriptProduct | null {
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const price = toNumber(source.price);
  if (name.length < 2 || price === undefined || price <= 0) return null;
  const originalPrice = toNumber(source.originalPrice);
  return {
    id: typeof source.id === 'string' && source.id ? source.id : fallbackId,
    name,
    price,
    ...(originalPrice !== undefined && originalPrice > price ? { originalPrice } : {}),
    ...(typeof source.unit === 'string' && source.unit ? { unit: source.unit.trim() } : {}),
    ...(typeof source.category === 'string' && source.category
      ? { category: source.category.trim() }
      : {}),
    priceSpelled: priceToWordsPtBr(price),
  };
}

/**
 * Varre o JSON do documento (formato do Editor V2 ou a `configuration` legada
 * dos encartes) atrás dos produtos posicionados na arte.
 *
 * O formato mudou entre gerações do editor e vai mudar de novo — por isso a
 * varredura é estrutural (procura `productData` e objetos com nome + preço) em
 * vez de assumir um caminho fixo.
 */
export function extractFlyerProducts(document: unknown): MascotScriptProduct[] {
  const found: MascotScriptProduct[] = [];
  const seen = new Set<string>();
  let counter = 0;

  const push = (candidate: Record<string, unknown>) => {
    const product = toProduct(candidate, `produto-${(counter += 1)}`);
    if (!product) return;
    const key = `${product.name.toLowerCase()}|${product.price}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(product);
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 12 || found.length >= 200) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;

    // Editor V2: elemento de produto carrega os dados em `productData`
    if (isRecord(node.productData)) {
      push(node.productData);
    } else if (node.type === 'product' && typeof node.name === 'string') {
      push(node);
    } else if (typeof node.name === 'string' && node.price !== undefined && !node.type) {
      // configuração legada: arrays de produtos soltos
      push(node);
    }

    for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(document, 0);
  return found;
}

/**
 * Ordena as ofertas pelo apelo comercial: maior desconto percentual primeiro,
 * depois o menor preço. É o critério que um encartista usa para escolher o que
 * vai ser falado nos primeiros segundos.
 */
export function rankOffers(products: MascotScriptProduct[]): MascotScriptProduct[] {
  return [...products].sort((a, b) => {
    const discountA = a.originalPrice ? 1 - a.price / a.originalPrice : 0;
    const discountB = b.originalPrice ? 1 - b.price / b.originalPrice : 0;
    if (discountA !== discountB) return discountB - discountA;
    return a.price - b.price;
  });
}

/** Quantas ofertas cabem confortavelmente na duração alvo. */
export function suggestProductCount(maxSeconds: number): number {
  // abertura + fechamento consomem ~4s; cada oferta falada leva ~2,5s
  const usable = Math.max(0, maxSeconds - 4);
  return Math.max(1, Math.min(8, Math.floor(usable / 2.5)));
}

function offerPhrase(product: MascotScriptProduct): string {
  const unit = product.unit && product.unit.toLowerCase() !== 'un' ? ` o ${product.unit}` : '';
  return `${product.name} por ${product.priceSpelled}${unit}`;
}

/**
 * Roteiro determinístico — usado quando a IA está indisponível ou devolve algo
 * fora do orçamento de duração. Nunca chama API paga.
 */
export function buildFallbackScript(options: {
  products: MascotScriptProduct[];
  tone: 'animado' | 'institucional';
  storeName?: string;
  callToAction?: string;
}): string {
  const { products, tone, storeName, callToAction } = options;
  const loja = storeName?.trim();
  if (products.length === 0) {
    return tone === 'animado'
      ? `Chegaram as ofertas da semana${loja ? ` no ${loja}` : ''}! Corre que é por tempo limitado.`
      : `Confira as ofertas da semana${loja ? ` no ${loja}` : ''}.`;
  }

  const opening =
    tone === 'animado'
      ? `Chegou a semana das ofertas${loja ? ` no ${loja}` : ''}!`
      : `Confira as ofertas desta semana${loja ? ` no ${loja}` : ''}.`;
  const phrases = products.map(offerPhrase);
  const middle =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(', ')} e ${phrases[phrases.length - 1]}`;
  const closing =
    callToAction?.trim() ||
    (tone === 'animado'
      ? 'Corre que é só até domingo!'
      : 'Ofertas válidas enquanto durarem os estoques.');

  return `${opening} ${middle[0].toUpperCase()}${middle.slice(1)}. ${closing}`;
}
