import { computeContentHash } from './input-hash';
import { McKitIdentityMode } from './mc-kit-identity';
import { parsePreco } from './mc-preco-extenso';
import { McSealProduct } from './mc-types';

/**
 * Peça de ofertas configurável (change video-peca-configuravel, grupo 2):
 * o DESCRITOR da peça que o cliente monta no editor e que vira o quadro
 * parado do vídeo — parte PURA, sem Nest/IO. Tudo em frações 0..1 do quadro
 * de saída (mesma convenção da janela do F1 e da caixa do logo), para o
 * mesmo documento alimentar a prévia do editor e o `render_still` do worker.
 *
 * Regras que este arquivo sustenta (specs video-piece-editor / -character /
 * -speech):
 * - um personagem por peça, com lado menor ≥ 25% da largura; `logo_face` só
 *   com kit `logo_as_is`;
 * - produtos 2..12 na grade, até 6 falados, nome legível (nunca arquivo/EAN),
 *   foto obrigatória em `/uploads/`, preço legível; imagem única com até 3;
 * - até 5 textos soltos, fontes só as da conta;
 * - produtos congelados na peça com `catalogId` para o aviso "preço mudou";
 * - mudança falada (nome/preço/unidade de item falado, ordem dos falados)
 *   reescreve a fala; mudança só visual reabre só a composição.
 */

export const MC_PIECE_SCHEMA_VERSION = 1;

/** Formatos admitidos no lançamento (spec "Peça com formato e cliente"). */
export const MC_PIECE_ASPECT_RATIOS = ['9:16', '4:5'] as const;
export type McPieceAspectRatio = (typeof MC_PIECE_ASPECT_RATIOS)[number];

export const MC_PIECE_MIN_PRODUCTS = 2;
export const MC_PIECE_MAX_PRODUCTS = 12;
export const MC_PIECE_MAX_SPOKEN = 6;
/** Roteiro da peça: ao menos uma oferta falada (o F2 exige 3). */
export const MC_OFFER_PIECE_MIN_OFFERS = 1;
/** Duração alvo do projeto gerado da peça (a fala manda; teto de 30 s medidos). */
export const MC_PIECE_DEFAULT_DURATION_S = 25;
/** Imagem única: até 3 produtos marcados só para a fala citar. */
export const MC_PIECE_SINGLE_MAX_PRODUCTS = 3;
export const MC_PIECE_MAX_TEXTS = 5;
/** Lado menor do personagem, fração da LARGURA do quadro (boca legível no vídeo). */
export const MC_PIECE_MIN_CHARACTER_WIDTH = 0.25;
/** Teto do descritor serializado (padrão dos 10 MB dos encartes, aqui mais apertado: não leva base64). */
export const MC_PIECE_MAX_BYTES = 2 * 1024 * 1024;
/** Folga numérica nas bordas do quadro (arredondamento do editor). */
const RECT_EPSILON = 1e-6;

/**
 * Issues ESTRUTURAIS: o descritor não é um documento de peça (schema,
 * formato, bloco sem id/duplicado/tipo desconhecido). O autosave recusa com
 * 422 PIECE_INVALID; todas as outras são regras de negócio ainda abertas
 * (sem personagem, poucos produtos) e voltam em `issues[]` sem bloquear.
 */
export const MC_PIECE_STRUCTURAL_CODES: readonly string[] = [
  'PIECE_EMPTY',
  'PIECE_SCHEMA',
  'PIECE_ASPECT',
  'BLOCK_WITHOUT_ID',
  'BLOCK_DUPLICATE_ID',
  'BLOCK_TYPE_INVALID',
];

export interface McPieceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type McPieceBackground =
  | { mode: 'solid'; color: string }
  | { mode: 'gradient'; colors: [string, string]; angle: number }
  | {
      mode: 'image';
      imageUrl: string;
      fit?: 'cover' | 'contain';
      /** 0..1 */
      blur?: number;
      /** 0..1 */
      darken?: number;
    };

export const MC_PIECE_BLOCK_TYPES = ['logo', 'text', 'footer', 'products', 'character'] as const;
export type McPieceBlockType = (typeof MC_PIECE_BLOCK_TYPES)[number];

interface McPieceBlockBase {
  id: string;
  type: McPieceBlockType;
  rect: McPieceRect;
  zIndex: number;
}

export interface McPieceLogoBlock extends McPieceBlockBase {
  type: 'logo';
  imageUrl: string | null;
}

export interface McPieceTextBlock extends McPieceBlockBase {
  type: 'text';
  text: string;
  /** Família de uma fonte da conta; ausente = fonte padrão da composição. */
  fontFamily?: string | null;
  /** Tamanho da fonte como fração da LARGURA do quadro (independe da resolução). */
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  weight: 'regular' | 'bold';
}

export interface McPieceFooterBlock extends McPieceBlockBase {
  type: 'footer';
  style: 'bar' | 'pill';
  address?: string | null;
  phone?: string | null;
  validity?: { from: string; to: string } | null;
  legal?: string | null;
  backgroundColor: string;
  textColor: string;
}

export interface McPieceProductItem {
  /** Chave estável do item na peça (vira `McSealProduct.id` e `productRef` da cena). */
  id: string;
  catalogId?: string | null;
  name: string;
  /** Gramatura/volume exibidos ("500 g", "2 L"); nunca falados. */
  grams?: string | null;
  unit?: string | null;
  /** "24,90" — já formatado, como `McSealProduct.price`. */
  price: string;
  originalPrice?: string | null;
  imageUrl: string;
  /** Posição dentro da área (fração do QUADRO); ausente em `layout: 'auto'`. */
  rect?: McPieceRect | null;
  featured?: boolean;
  /** Entra na fala do personagem (até MC_PIECE_MAX_SPOKEN). */
  spoken: boolean;
}

export interface McPieceProductsBlock extends McPieceBlockBase {
  type: 'products';
  mode: 'grid' | 'single';
  layout: 'auto' | 'manual';
  areaStyle?: { background?: string | null; radius?: number; shadow?: boolean } | null;
  tagStyle?: { kind: 'badge' | 'plain'; color: string; textColor: string } | null;
  items: McPieceProductItem[];
  /** Foto montada pelo cliente (modo `single`). */
  singleImageUrl?: string | null;
}

export interface McPieceCharacterBlock extends McPieceBlockBase {
  type: 'character';
  kitId: string;
  mode: 'in_piece' | 'logo_face';
  /** Painel liso atrás do personagem (lançamento: sempre liso; `none` só com chroma, fase 2). */
  panel: { shape: 'none' | 'card' | 'circle'; color: string };
}

export type McPieceBlock =
  | McPieceLogoBlock
  | McPieceTextBlock
  | McPieceFooterBlock
  | McPieceProductsBlock
  | McPieceCharacterBlock;

export interface McPieceFont {
  family: string;
  /** URL em /uploads/fonts/… (o render carrega por URL absoluta). */
  url: string;
}

export interface McPieceDocument {
  schemaVersion: number;
  aspectRatio: McPieceAspectRatio;
  background: McPieceBackground;
  blocks: McPieceBlock[];
  /** Fontes da conta usadas pelos textos (família + arquivo), para o render. */
  fonts?: McPieceFont[];
}

/**
 * Peça em branco (spec "Peça com formato e cliente"): fundo claro, área de
 * produtos vazia em auto-layout e rodapé em faixa. Logo entra por
 * `applyClientToPiece`; personagem e textos o cliente escolhe. Não passa na
 * validação até ter personagem e produtos — por desenho (`issues[]`).
 */
export function defaultPieceDocument(aspectRatio: McPieceAspectRatio): McPieceDocument {
  return {
    schemaVersion: MC_PIECE_SCHEMA_VERSION,
    aspectRatio,
    background: { mode: 'solid', color: '#F3F4F6' },
    blocks: [
      {
        id: 'products',
        type: 'products',
        rect: { x: 0.05, y: 0.2, w: 0.9, h: 0.52 },
        zIndex: 1,
        mode: 'grid',
        layout: 'auto',
        areaStyle: { background: '#FFFFFF', radius: 0.03, shadow: true },
        tagStyle: { kind: 'badge', color: '#D32F2F', textColor: '#FFFFFF' },
        items: [],
      },
      {
        id: 'footer',
        type: 'footer',
        rect: { x: 0, y: 0.92, w: 1, h: 0.08 },
        zIndex: 2,
        style: 'bar',
        legal: 'ou enquanto durarem os estoques',
        backgroundColor: '#111827',
        textColor: '#FFFFFF',
      },
    ],
  };
}

// ───────────────────────────── validação ─────────────────────────────

export interface McPieceIssue {
  code: string;
  blockId?: string;
  itemId?: string;
  message: string;
}

export interface McPieceValidationContext {
  /** Modo de identidade do kit escolhido (para `logo_face`); ausente = não checa. */
  kitIdentityMode?: McKitIdentityMode | null;
  /** Famílias de fontes da conta; ausente = não checa a fonte dos textos. */
  fontFamilies?: readonly string[] | null;
}

const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const UPLOADS_URL = /\/uploads\//;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRect(value: unknown): value is McPieceRect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.w) && isFiniteNumber(r.h);
}

/** Retângulo com área e inteiro dentro do quadro (0..1 nos dois eixos). */
export function rectInsideFrame(rect: McPieceRect): boolean {
  return (
    rect.w > 0 &&
    rect.h > 0 &&
    rect.x >= -RECT_EPSILON &&
    rect.y >= -RECT_EPSILON &&
    rect.x + rect.w <= 1 + RECT_EPSILON &&
    rect.y + rect.h <= 1 + RECT_EPSILON
  );
}

function foldName(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Nome legível para a tela e para a fala (spec "nunca nome de arquivo ou
 * EAN"): precisa de letras, e não pode ser nome de arquivo, código de barras
 * ou o nome automático de uma foto.
 */
export function isReadableProductName(name: string | null | undefined): boolean {
  const text = (name ?? '').trim();
  if (text.length < 2) return false;
  const folded = foldName(text);
  if ((folded.match(/[a-z]/g) ?? []).length < 3) return false;
  if (/\.(png|jpe?g|webp|gif|heic|bmp|tiff?)$/i.test(folded)) return false;
  if (/\d{8,}/.test(folded)) return false;
  if (
    /^(whatsapp image|whatsapp video|screenshot|captura de tela|img[_ -]|image[_ -]|photo[_ -]|dsc[_ -]?\d)/i.test(
      folded,
    )
  ) {
    return false;
  }
  return true;
}

function productsBlockIssues(block: McPieceProductsBlock): McPieceIssue[] {
  const issues: McPieceIssue[] = [];
  const blockId = block.id;
  const items = Array.isArray(block.items) ? block.items : [];
  if (block.mode === 'single') {
    if (!block.singleImageUrl || !UPLOADS_URL.test(block.singleImageUrl)) {
      issues.push({
        code: 'SINGLE_IMAGE_REQUIRED',
        blockId,
        message: 'A imagem única dos produtos precisa de uma foto da galeria.',
      });
    }
    if (items.length > MC_PIECE_SINGLE_MAX_PRODUCTS) {
      issues.push({
        code: 'PRODUCTS_TOO_MANY',
        blockId,
        message: `Imagem única aceita até ${MC_PIECE_SINGLE_MAX_PRODUCTS} produtos citados.`,
      });
    }
  } else {
    if (items.length < MC_PIECE_MIN_PRODUCTS) {
      issues.push({
        code: 'PRODUCTS_TOO_FEW',
        blockId,
        message: `A área de produtos precisa de pelo menos ${MC_PIECE_MIN_PRODUCTS} produtos.`,
      });
    }
    if (items.length > MC_PIECE_MAX_PRODUCTS) {
      issues.push({
        code: 'PRODUCTS_TOO_MANY',
        blockId,
        message: `A área de produtos aceita até ${MC_PIECE_MAX_PRODUCTS} produtos.`,
      });
    }
  }
  const seen = new Set<string>();
  let spoken = 0;
  for (const item of items) {
    const itemId = typeof item.id === 'string' ? item.id : '';
    if (!itemId) {
      issues.push({ code: 'PRODUCT_WITHOUT_ID', blockId, message: 'Produto sem chave na peça.' });
    } else if (seen.has(itemId)) {
      issues.push({
        code: 'PRODUCT_DUPLICATE_ID',
        blockId,
        itemId,
        message: `Produto duplicado na peça: ${itemId}.`,
      });
    }
    seen.add(itemId);
    if (!isReadableProductName(item.name)) {
      issues.push({
        code: 'PRODUCT_NAME_UNREADABLE',
        blockId,
        itemId,
        message: `Produto "${(item.name ?? '').trim() || '(sem nome)'}" precisa de um nome legível (não arquivo nem código).`,
      });
    }
    if (!item.imageUrl) {
      issues.push({
        code: 'PRODUCT_IMAGE_REQUIRED',
        blockId,
        itemId,
        message: `Produto "${item.name}" precisa de uma foto da galeria.`,
      });
    } else if (!UPLOADS_URL.test(item.imageUrl)) {
      issues.push({
        code: 'PRODUCT_IMAGE_URL',
        blockId,
        itemId,
        message: `A foto de "${item.name}" precisa apontar para um arquivo em /uploads/.`,
      });
    }
    if (!parsePreco(item.price ?? '')) {
      issues.push({
        code: 'PRODUCT_PRICE_INVALID',
        blockId,
        itemId,
        message: `Preço de "${item.name}" ilegível: "${item.price ?? ''}".`,
      });
    }
    if (item.originalPrice && !parsePreco(item.originalPrice)) {
      issues.push({
        code: 'PRODUCT_ORIGINAL_PRICE_INVALID',
        blockId,
        itemId,
        message: `Preço anterior de "${item.name}" ilegível: "${item.originalPrice}".`,
      });
    }
    if (block.layout === 'manual' && block.mode === 'grid' && (!item.rect || !isRect(item.rect))) {
      issues.push({
        code: 'PRODUCT_RECT_MISSING',
        blockId,
        itemId,
        message: `Produto "${item.name}" sem posição no layout manual.`,
      });
    } else if (item.rect && isRect(item.rect) && !rectInsideFrame(item.rect)) {
      issues.push({
        code: 'PRODUCT_OUT_OF_FRAME',
        blockId,
        itemId,
        message: `Produto "${item.name}" fora do quadro.`,
      });
    }
    if (item.spoken) spoken += 1;
  }
  if (spoken > MC_PIECE_MAX_SPOKEN) {
    issues.push({
      code: 'SPOKEN_TOO_MANY',
      blockId,
      message: `Até ${MC_PIECE_MAX_SPOKEN} produtos podem entrar na fala (${spoken} marcados).`,
    });
  }
  if (items.length > 0 && spoken === 0) {
    issues.push({
      code: 'SPOKEN_NONE',
      blockId,
      message: 'Marque pelo menos um produto para o personagem falar.',
    });
  }
  return issues;
}

function backgroundIssues(background: McPieceBackground | undefined): McPieceIssue[] {
  if (!background || typeof background !== 'object') {
    return [{ code: 'BACKGROUND_INVALID', message: 'A peça precisa de um fundo.' }];
  }
  switch (background.mode) {
    case 'solid':
      return HEX_COLOR.test(background.color ?? '')
        ? []
        : [{ code: 'BACKGROUND_INVALID', message: 'Cor do fundo inválida (use #RRGGBB).' }];
    case 'gradient': {
      const colors = Array.isArray(background.colors) ? background.colors : [];
      const ok =
        colors.length === 2 &&
        colors.every((c) => HEX_COLOR.test(c ?? '')) &&
        isFiniteNumber(background.angle);
      return ok
        ? []
        : [
            {
              code: 'BACKGROUND_INVALID',
              message: 'Degradê precisa de duas cores #RRGGBB e um ângulo.',
            },
          ];
    }
    case 'image': {
      const issues: McPieceIssue[] = [];
      if (!background.imageUrl || !UPLOADS_URL.test(background.imageUrl)) {
        issues.push({
          code: 'BACKGROUND_INVALID',
          message: 'A imagem de fundo precisa apontar para um arquivo em /uploads/.',
        });
      }
      for (const key of ['blur', 'darken'] as const) {
        const value = background[key];
        if (value != null && (!isFiniteNumber(value) || value < 0 || value > 1)) {
          issues.push({
            code: 'BACKGROUND_INVALID',
            message: `"${key}" do fundo precisa ficar entre 0 e 1.`,
          });
        }
      }
      return issues;
    }
    default:
      return [{ code: 'BACKGROUND_INVALID', message: 'Modo de fundo desconhecido.' }];
  }
}

/**
 * Validação do descritor (D13: a tela aponta o bloco). Forma básica
 * (schema, formato, blocos, retângulos) e as regras de negócio das specs.
 * Vazio = peça pronta para gerar.
 */
export function validatePieceDocument(
  document: McPieceDocument,
  ctx: McPieceValidationContext = {},
): McPieceIssue[] {
  const issues: McPieceIssue[] = [];
  if (!document || typeof document !== 'object') {
    return [{ code: 'PIECE_EMPTY', message: 'A peça está vazia.' }];
  }
  if (document.schemaVersion !== MC_PIECE_SCHEMA_VERSION) {
    issues.push({
      code: 'PIECE_SCHEMA',
      message: `Versão do descritor não suportada: ${String(document.schemaVersion)}.`,
    });
  }
  if (!(MC_PIECE_ASPECT_RATIOS as readonly string[]).includes(document.aspectRatio)) {
    issues.push({
      code: 'PIECE_ASPECT',
      message: `Formato não disponível para a peça: ${String(document.aspectRatio)}.`,
    });
  }
  issues.push(...backgroundIssues(document.background));

  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  const ids = new Set<string>();
  const fontFamilies = ctx.fontFamilies
    ? new Set(ctx.fontFamilies.map((f) => f.trim().toLowerCase()))
    : null;
  let characters = 0;
  let productsBlocks = 0;
  let texts = 0;
  for (const block of blocks) {
    const blockId = typeof block?.id === 'string' ? block.id : '';
    if (!blockId) {
      issues.push({ code: 'BLOCK_WITHOUT_ID', message: 'Bloco sem identidade.' });
    } else if (ids.has(blockId)) {
      issues.push({ code: 'BLOCK_DUPLICATE_ID', blockId, message: `Bloco duplicado: ${blockId}.` });
    }
    ids.add(blockId);
    if (!(MC_PIECE_BLOCK_TYPES as readonly string[]).includes(block?.type)) {
      issues.push({
        code: 'BLOCK_TYPE_INVALID',
        blockId,
        message: `Tipo de bloco desconhecido: ${String(block?.type)}.`,
      });
      continue;
    }
    if (!isRect(block.rect) || !rectInsideFrame(block.rect)) {
      issues.push({
        code: 'BLOCK_OUT_OF_FRAME',
        blockId,
        message: `Bloco ${block.type} fora do quadro.`,
      });
    }
    if (!isFiniteNumber(block.zIndex)) {
      issues.push({
        code: 'BLOCK_ZINDEX_INVALID',
        blockId,
        message: `Bloco ${block.type} sem ordem de camada.`,
      });
    }
    switch (block.type) {
      case 'logo':
        if (block.imageUrl && !UPLOADS_URL.test(block.imageUrl)) {
          issues.push({
            code: 'LOGO_IMAGE_URL',
            blockId,
            message: 'A logo precisa apontar para um arquivo em /uploads/.',
          });
        }
        break;
      case 'text': {
        texts += 1;
        if (!(block.text ?? '').trim()) {
          issues.push({ code: 'TEXT_EMPTY', blockId, message: 'Texto solto vazio.' });
        }
        if (!isFiniteNumber(block.fontSize) || block.fontSize <= 0 || block.fontSize > 0.5) {
          issues.push({
            code: 'TEXT_SIZE_INVALID',
            blockId,
            message: 'Tamanho do texto fora da faixa (fração da largura, até 0,5).',
          });
        }
        if (!HEX_COLOR.test(block.color ?? '')) {
          issues.push({
            code: 'TEXT_COLOR_INVALID',
            blockId,
            message: 'Cor do texto inválida (use #RRGGBB).',
          });
        }
        if (
          block.fontFamily &&
          fontFamilies &&
          !fontFamilies.has(block.fontFamily.trim().toLowerCase())
        ) {
          issues.push({
            code: 'FONT_UNKNOWN',
            blockId,
            message: `Fonte "${block.fontFamily}" não está cadastrada na conta.`,
          });
        }
        break;
      }
      case 'footer':
        if (
          !HEX_COLOR.test(block.backgroundColor ?? '') ||
          !HEX_COLOR.test(block.textColor ?? '')
        ) {
          issues.push({
            code: 'FOOTER_COLOR_INVALID',
            blockId,
            message: 'Cores do rodapé inválidas (use #RRGGBB).',
          });
        }
        if (block.validity && (!block.validity.from || !block.validity.to)) {
          issues.push({
            code: 'FOOTER_VALIDITY_INVALID',
            blockId,
            message: 'Validade precisa de data inicial e final.',
          });
        }
        break;
      case 'products':
        productsBlocks += 1;
        issues.push(...productsBlockIssues(block));
        break;
      case 'character': {
        characters += 1;
        if (!block.kitId) {
          issues.push({
            code: 'CHARACTER_KIT_REQUIRED',
            blockId,
            message: 'Escolha o kit do personagem.',
          });
        }
        if (
          isRect(block.rect) &&
          Math.min(block.rect.w, block.rect.h) < MC_PIECE_MIN_CHARACTER_WIDTH - RECT_EPSILON
        ) {
          issues.push({
            code: 'CHARACTER_TOO_SMALL',
            blockId,
            message: `O personagem precisa ter pelo menos ${Math.round(MC_PIECE_MIN_CHARACTER_WIDTH * 100)}% da largura do quadro para a boca ficar legível.`,
          });
        }
        if (
          block.mode === 'logo_face' &&
          ctx.kitIdentityMode &&
          ctx.kitIdentityMode !== 'logo_as_is'
        ) {
          issues.push({
            code: 'CHARACTER_LOGO_FACE_REQUIRES_LOGO_KIT',
            blockId,
            message: 'O modo "rosto do logo" só funciona com um kit de logo usado como está.',
          });
        }
        if (!block.panel || !HEX_COLOR.test(block.panel.color ?? '')) {
          issues.push({
            code: 'CHARACTER_PANEL_INVALID',
            blockId,
            message: 'Cor do painel do personagem inválida (use #RRGGBB).',
          });
        }
        break;
      }
      default:
        break;
    }
  }
  if (characters === 0) {
    issues.push({ code: 'CHARACTER_MISSING', message: 'A peça precisa de um personagem.' });
  } else if (characters > 1) {
    issues.push({ code: 'CHARACTER_DUPLICATE', message: 'A peça aceita um personagem só.' });
  }
  if (productsBlocks === 0) {
    issues.push({ code: 'PRODUCTS_MISSING', message: 'A peça precisa de uma área de produtos.' });
  } else if (productsBlocks > 1) {
    issues.push({ code: 'PRODUCTS_DUPLICATE', message: 'A peça aceita uma área de produtos só.' });
  }
  if (texts > MC_PIECE_MAX_TEXTS) {
    issues.push({
      code: 'TEXTS_TOO_MANY',
      message: `A peça aceita até ${MC_PIECE_MAX_TEXTS} textos soltos.`,
    });
  }
  return issues;
}

/** Tamanho do descritor serializado (UTF-8); acima de MC_PIECE_MAX_BYTES o service responde PIECE_TOO_LARGE. */
export function pieceDocumentBytes(document: McPieceDocument): number {
  return Buffer.byteLength(JSON.stringify(document), 'utf8');
}

// ───────────────────────────── derivações ─────────────────────────────

/** Hash canônico do descritor (chaves ordenadas, espaços colapsados): entra no hash do `render_still`. */
export function pieceCanonicalHash(document: McPieceDocument): string {
  return computeContentHash(document as unknown as Record<string, unknown>);
}

export function pieceBlock<T extends McPieceBlock['type']>(
  document: McPieceDocument,
  type: T,
): Extract<McPieceBlock, { type: T }> | null {
  const block = (document.blocks ?? []).find((b) => b.type === type);
  return (block as Extract<McPieceBlock, { type: T }> | undefined) ?? null;
}

/**
 * Ofertas FALADAS na ordem da peça → `McSealProduct[]` (ponte para o diretor
 * do F2 e para `options.products` do projeto). `id` = chave do item (vira
 * `productRef` da cena); gramatura não entra no nome falado.
 */
export function pieceSpokenOffers(document: McPieceDocument): McSealProduct[] {
  const products = pieceBlock(document, 'products');
  if (!products) return [];
  return products.items
    .filter((item) => item.spoken)
    .map((item) => ({
      id: item.id,
      catalogId: item.catalogId ?? null,
      name: item.name.trim(),
      price: item.price.trim(),
      originalPrice: item.originalPrice ?? null,
      unit: item.unit ?? null,
      imageUrl: item.imageUrl,
    }));
}

export interface McPieceClientInfo {
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
}

/** Logo padrão: canto superior esquerdo, 28% da largura, quadrada em fração. */
const DEFAULT_LOGO_RECT: McPieceRect = { x: 0.06, y: 0.04, w: 0.28, h: 0.12 };

/**
 * Aplica o cliente à peça: logo (cria o bloco quando falta e o cliente tem
 * logo) e rodapé (endereço/telefone, quando há bloco). Nunca mexe no resto.
 */
export function applyClientToPiece(
  document: McPieceDocument,
  client: McPieceClientInfo,
): McPieceDocument {
  const blocks = (document.blocks ?? []).map((block) => {
    if (block.type === 'logo') return { ...block, imageUrl: client.logoUrl ?? block.imageUrl };
    if (block.type === 'footer') {
      return {
        ...block,
        address: client.address ?? block.address ?? null,
        phone: client.phone ?? block.phone ?? null,
      };
    }
    return block;
  });
  if (client.logoUrl && !blocks.some((b) => b.type === 'logo')) {
    const zIndex = blocks.reduce((max, b) => Math.max(max, b.zIndex ?? 0), 0) + 1;
    blocks.push({
      id: 'logo',
      type: 'logo',
      rect: { ...DEFAULT_LOGO_RECT },
      zIndex,
      imageUrl: client.logoUrl,
    });
  }
  return { ...document, blocks };
}

/**
 * Modelo a partir da peça (spec "Modelos salvos"): guarda fundo, posições,
 * estilos, textos e rodapé; sai o que é do cliente ou da semana (logo,
 * produtos, imagem única, endereço/telefone/validade).
 */
export function templateFromPiece(document: McPieceDocument): McPieceDocument {
  const blocks = (document.blocks ?? []).map((block): McPieceBlock => {
    switch (block.type) {
      case 'logo':
        return { ...block, imageUrl: null };
      case 'products':
        return { ...block, items: [], singleImageUrl: null, layout: 'auto' };
      case 'footer':
        return { ...block, address: null, phone: null, validity: null };
      default:
        return block;
    }
  });
  return { ...document, blocks };
}

/**
 * Validade do rodapé como dica para o fechamento da fala ("até 16/04"):
 * `to` em ISO (YYYY-MM-DD) vira DD/MM; ausente ou ilegível → null.
 */
export function pieceValidityHint(
  validity: { from?: string | null; to?: string | null } | null | undefined,
): string | null {
  const to = (validity?.to ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(to);
  if (!match) return null;
  return `até ${match[3]}/${match[2]}`;
}

/** Famílias de fonte citadas pelos textos da peça (sem repetição, em ordem de uso). */
export function pieceFontFamilies(document: McPieceDocument): string[] {
  const families: string[] = [];
  for (const block of document.blocks ?? []) {
    if (block.type !== 'text') continue;
    const family = (block.fontFamily ?? '').trim();
    if (family && !families.includes(family)) families.push(family);
  }
  return families;
}

/**
 * Fontes que o quadro parado carrega (6.1/6.2): para cada família citada por
 * um texto, o arquivo da conta (`fonts.fileUrl`) — a primeira variante
 * cadastrada da família. Família sem arquivo fica de fora (a composição usa a
 * fonte padrão; a validação já aponta `TEXT_FONT_UNKNOWN`). Ordenado por
 * família: entra assim no hash do render.
 */
export function resolvePieceFonts(
  document: McPieceDocument,
  rows: Array<{ family: string; fileUrl: string }>,
): McPieceFont[] {
  const fonts: McPieceFont[] = [];
  for (const family of pieceFontFamilies(document)) {
    const row = rows.find((r) => r.family === family && (r.fileUrl ?? '').trim());
    if (row) fonts.push({ family, url: row.fileUrl.trim() });
  }
  return fonts.sort((a, b) => a.family.localeCompare(b.family));
}

export type McPieceChangeScope = 'none' | 'visual' | 'spoken';

/** O que a fala enxerga de cada oferta falada (ordem conta). */
function spokenSignature(document: McPieceDocument): string {
  return JSON.stringify(
    pieceSpokenOffers(document).map((o) => [o.id, o.name, o.price, o.unit ?? null]),
  );
}

/**
 * Escopo de uma edição da peça (spec "Preço alterado depois do vídeo" e regra
 * do `PATCH /composition` do F2): `spoken` quando muda o que o personagem
 * fala (ofertas faladas, seus nomes, preços, unidades ou ordem) → reescreve
 * a frase e volta à revisão do roteiro; `visual` quando só o quadro muda →
 * revisão só da composição; `none` quando nada mudou.
 */
export function pieceChangeScope(
  before: McPieceDocument,
  after: McPieceDocument,
): McPieceChangeScope {
  if (spokenSignature(before) !== spokenSignature(after)) return 'spoken';
  return pieceCanonicalHash(before) === pieceCanonicalHash(after) ? 'none' : 'visual';
}
