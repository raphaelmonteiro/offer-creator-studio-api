import { absoluteAssetUrl } from './mc-offer-carousel-props';
import {
  McPieceBlock,
  McPieceDocument,
  McPieceFont,
  McPieceProductItem,
  McPieceRect,
} from './mc-piece';
import { layoutPieceProducts, PieceLayoutResult } from './mc-piece-layout';

/**
 * Props da composição `OfferPieceStill` (change video-peca-configuravel, 6.2)
 * — o quadro PARADO da peça de ofertas que o worker renderiza com o Remotion
 * (`renderStill`) e que o `compose_ffmpeg` usa como arte de fundo.
 *
 * Parte PURA: o descritor congelado do projeto (`pieceSnapshot`) com TODAS as
 * mídias em URL absoluta (o navegador do render busca em
 * `MC_RENDER_ASSET_BASE_URL`), as dimensões do formato e as fontes da conta.
 * O mesmo arquivo descreve o plano do renderizador MOCK (sharp): fundo +
 * retângulos, para o e2e sem navegador.
 */

export interface OfferPieceStillProps {
  document: McPieceDocument;
  width: number;
  height: number;
  fonts: McPieceFont[];
}

/** URLs de mídia que a peça referencia (fundo, logo, fotos, imagem única), sem repetição. */
export function pieceMediaUrls(document: McPieceDocument): string[] {
  const urls: string[] = [];
  const add = (url: string | null | undefined) => {
    const trimmed = (url ?? '').trim();
    if (trimmed && !urls.includes(trimmed)) urls.push(trimmed);
  };
  if (document.background?.mode === 'image') add(document.background.imageUrl);
  for (const block of document.blocks ?? []) {
    if (block.type === 'logo') add(block.imageUrl);
    if (block.type === 'products') {
      add(block.singleImageUrl);
      for (const item of block.items ?? []) add(item.imageUrl);
    }
  }
  return urls;
}

/**
 * Descritor com mídias e fontes em URL absoluta + mapa URL absoluta → URL
 * original (o processor resolve o arquivo local de cada uma para o mock).
 */
export function buildOfferPieceStillProps(input: {
  document: McPieceDocument;
  width: number;
  height: number;
  fonts: McPieceFont[];
  assetBaseUrl: string;
}): { props: OfferPieceStillProps; sources: Record<string, string> } {
  const sources: Record<string, string> = {};
  const abs = (url: string): string => {
    const absolute = absoluteAssetUrl(url, input.assetBaseUrl);
    sources[absolute] = url;
    return absolute;
  };
  const optional = (url: string | null | undefined): string | null =>
    (url ?? '').trim() ? abs((url as string).trim()) : null;
  const background =
    input.document.background?.mode === 'image'
      ? { ...input.document.background, imageUrl: abs(input.document.background.imageUrl) }
      : input.document.background;
  const blocks: McPieceBlock[] = (input.document.blocks ?? []).map((block) => {
    if (block.type === 'logo') return { ...block, imageUrl: optional(block.imageUrl) };
    if (block.type === 'products') {
      return {
        ...block,
        singleImageUrl: optional(block.singleImageUrl),
        items: (block.items ?? []).map((item) => ({ ...item, imageUrl: abs(item.imageUrl) })),
      };
    }
    return block;
  });
  const fonts = input.fonts.map((f) => ({ family: f.family, url: abs(f.url) }));
  return {
    props: {
      document: { ...input.document, background, blocks, fonts },
      width: input.width,
      height: input.height,
      fonts,
    },
    sources,
  };
}

// ───────────────────────────── plano do mock (sharp) ─────────────────────────────

export interface MockStillRectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function pieceRectToPx(rect: McPieceRect, width: number, height: number): MockStillRectPx {
  const x = Math.round(rect.x * width);
  const y = Math.round(rect.y * height);
  return {
    x,
    y,
    width: Math.max(1, Math.round((rect.x + rect.w) * width) - x),
    height: Math.max(1, Math.round((rect.y + rect.h) * height) - y),
  };
}

/**
 * Grade do mock para a área de produtos em `layout: 'auto'` (o auto-layout
 * REAL vive em `@chroma/video-templates`/`layoutProducts`; este só precisa de
 * células plausíveis): colunas por quantidade, células com folga de 2% da área.
 */
export function mockGridCells(area: MockStillRectPx, count: number): MockStillRectPx[] {
  if (count <= 0) return [];
  const cols = count <= 2 ? count : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  const rows = Math.ceil(count / cols);
  const gapX = Math.round(area.width * 0.02);
  const gapY = Math.round(area.height * 0.02);
  const cellW = Math.floor((area.width - gapX * (cols + 1)) / cols);
  const cellH = Math.floor((area.height - gapY * (rows + 1)) / rows);
  const cells: MockStillRectPx[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cells.push({
      x: area.x + gapX + col * (cellW + gapX),
      y: area.y + gapY + row * (cellH + gapY),
      width: Math.max(1, cellW),
      height: Math.max(1, cellH),
    });
  }
  return cells;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeColor(color: string | null | undefined, fallback: string): string {
  const trimmed = (color ?? '').trim();
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(trimmed) ? trimmed : fallback;
}

/** Ponto final de um degradê linear por ângulo (graus, 0 = de baixo para cima como no CSS). */
function gradientVector(angle: number): { x1: number; y1: number; x2: number; y2: number } {
  const rad = ((angle % 360) * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return {
    x1: 0.5 - dx / 2,
    y1: 0.5 - dy / 2,
    x2: 0.5 + dx / 2,
    y2: 0.5 + dy / 2,
  };
}

export interface MockStillPlan {
  /** Fundo sólido/degradê como SVG do tamanho do quadro; null quando o fundo é imagem. */
  backgroundSvg: string | null;
  /** Fundo em imagem: URL (como veio nas props) e ajustes; null nos outros modos. */
  backgroundImage: {
    url: string;
    fit: 'cover' | 'contain';
    blur: number;
    darken: number;
  } | null;
  /** Blocos desenhados por cima (SVG do tamanho do quadro, com transparência). */
  overlaySvg: string;
  width: number;
  height: number;
}

function productCellSvg(
  cell: MockStillRectPx,
  item: McPieceProductItem,
  tag: { color: string; textColor: string },
): string {
  const pad = Math.round(cell.width * 0.06);
  const nameSize = Math.max(14, Math.round(cell.width * 0.09));
  const priceSize = Math.max(18, Math.round(cell.width * 0.16));
  const photoH = Math.round(cell.height * 0.5);
  return (
    `<rect x="${cell.x}" y="${cell.y}" width="${cell.width}" height="${cell.height}" rx="${pad}" fill="#FFFFFF" stroke="#E5E7EB" stroke-width="2"/>` +
    `<rect x="${cell.x + pad}" y="${cell.y + pad}" width="${cell.width - pad * 2}" height="${photoH}" rx="${Math.round(pad / 2)}" fill="#E5E7EB"/>` +
    `<text x="${cell.x + pad}" y="${cell.y + pad + photoH + nameSize + 4}" font-family="DejaVu Sans, sans-serif" font-size="${nameSize}" fill="#111827">${escapeXml(item.name.slice(0, 28))}</text>` +
    (item.originalPrice
      ? `<text x="${cell.x + pad}" y="${cell.y + cell.height - priceSize - pad}" font-family="DejaVu Sans, sans-serif" font-size="${Math.round(nameSize * 0.9)}" fill="#6B7280" text-decoration="line-through">de R$ ${escapeXml(item.originalPrice)}</text>`
      : '') +
    `<rect x="${cell.x + pad}" y="${cell.y + cell.height - priceSize - pad + 4}" width="${cell.width - pad * 2}" height="${priceSize}" rx="${Math.round(priceSize / 4)}" fill="${tag.color}"/>` +
    `<text x="${cell.x + pad * 2}" y="${cell.y + cell.height - pad - Math.round(priceSize * 0.22)}" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="${Math.round(priceSize * 0.62)}" fill="${tag.textColor}">R$ ${escapeXml(item.price)}${item.unit ? `/${escapeXml(item.unit)}` : ''}</text>`
  );
}

/**
 * Plano do renderizador MOCK (sharp): fundo + um retângulo por bloco — logo em
 * caixa clara, textos com a cor e o tamanho pedidos, rodapé em faixa com
 * endereço/telefone/validade, área de produtos com células na grade, painel
 * liso do personagem na cor do bloco. Puro: só strings SVG e números.
 */
export function buildMockStillPlan(props: OfferPieceStillProps): MockStillPlan {
  const { width: W, height: H } = props;
  const doc = props.document;
  let backgroundSvg: string | null = null;
  let backgroundImage: MockStillPlan['backgroundImage'] = null;
  const bg = doc.background;
  if (bg?.mode === 'image') {
    backgroundImage = {
      url: bg.imageUrl,
      fit: bg.fit ?? 'cover',
      blur: Math.max(0, Math.min(1, bg.blur ?? 0)),
      darken: Math.max(0, Math.min(1, bg.darken ?? 0)),
    };
  } else if (bg?.mode === 'gradient') {
    const v = gradientVector(Number.isFinite(bg.angle) ? bg.angle : 180);
    backgroundSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><linearGradient id="g" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}">` +
      `<stop offset="0" stop-color="${safeColor(bg.colors?.[0], '#D32F2F')}"/>` +
      `<stop offset="1" stop-color="${safeColor(bg.colors?.[1], '#F9A825')}"/>` +
      `</linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
  } else {
    const color = safeColor(bg && 'color' in bg ? bg.color : null, '#F3F4F6');
    backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${color}"/></svg>`;
  }

  const parts: string[] = [];
  const blocks = [...(doc.blocks ?? [])].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  for (const block of blocks) {
    const px = pieceRectToPx(block.rect, W, H);
    switch (block.type) {
      case 'logo': {
        parts.push(
          `<rect x="${px.x}" y="${px.y}" width="${px.width}" height="${px.height}" rx="${Math.round(px.height * 0.1)}" fill="#FFFFFF" fill-opacity="0.9"/>`,
          `<text x="${px.x + px.width / 2}" y="${px.y + px.height / 2}" dominant-baseline="middle" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${Math.max(14, Math.round(px.height * 0.3))}" fill="#9CA3AF">LOGO</text>`,
        );
        break;
      }
      case 'text': {
        const size = Math.max(10, Math.round((block.fontSize || 0.05) * W));
        const anchor =
          block.align === 'center' ? 'middle' : block.align === 'right' ? 'end' : 'start';
        const x =
          block.align === 'center'
            ? px.x + px.width / 2
            : block.align === 'right'
              ? px.x + px.width
              : px.x;
        parts.push(
          `<text x="${x}" y="${px.y + size}" text-anchor="${anchor}" font-family="DejaVu Sans, sans-serif" font-weight="${block.weight === 'bold' ? 'bold' : 'normal'}" font-size="${size}" fill="${safeColor(block.color, '#111827')}">${escapeXml((block.text ?? '').slice(0, 80))}</text>`,
        );
        break;
      }
      case 'footer': {
        const rx = block.style === 'pill' ? Math.round(px.height / 2) : 0;
        const size = Math.max(12, Math.round(px.height * 0.3));
        const pieces = [block.address, block.phone].map((s) => (s ?? '').trim()).filter(Boolean);
        if (block.validity?.from && block.validity?.to) {
          pieces.push(`válido de ${block.validity.from} a ${block.validity.to}`);
        }
        if ((block.legal ?? '').trim()) pieces.push((block.legal as string).trim());
        parts.push(
          `<rect x="${px.x}" y="${px.y}" width="${px.width}" height="${px.height}" rx="${rx}" fill="${safeColor(block.backgroundColor, '#111827')}"/>`,
          `<text x="${px.x + px.width / 2}" y="${px.y + px.height / 2}" dominant-baseline="middle" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${size}" fill="${safeColor(block.textColor, '#FFFFFF')}">${escapeXml(pieces.join(' · ').slice(0, 120))}</text>`,
        );
        break;
      }
      case 'products': {
        const area = block.areaStyle;
        if (area?.background) {
          parts.push(
            `<rect x="${px.x}" y="${px.y}" width="${px.width}" height="${px.height}" rx="${Math.round((area.radius ?? 0) * W)}" fill="${safeColor(area.background, '#FFFFFF')}"/>`,
          );
        }
        const tag = {
          color: safeColor(block.tagStyle?.color, '#D32F2F'),
          textColor: safeColor(block.tagStyle?.textColor, '#FFFFFF'),
        };
        const items = block.items ?? [];
        if (block.mode === 'single') {
          const pad = Math.round(px.width * 0.03);
          parts.push(
            `<rect x="${px.x + pad}" y="${px.y + pad}" width="${px.width - pad * 2}" height="${px.height - pad * 2}" fill="#E5E7EB"/>`,
          );
          const tagH = Math.max(24, Math.round(px.width * 0.08));
          items.slice(0, 3).forEach((item, i) => {
            const y = px.y + px.height - pad - (i + 1) * (tagH + 6);
            parts.push(
              `<rect x="${px.x + pad * 2}" y="${y}" width="${Math.round(px.width * 0.5)}" height="${tagH}" rx="${Math.round(tagH / 4)}" fill="${tag.color}"/>`,
              `<text x="${px.x + pad * 3}" y="${y + Math.round(tagH * 0.68)}" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="${Math.round(tagH * 0.55)}" fill="${tag.textColor}">${escapeXml(item.name.slice(0, 18))} R$ ${escapeXml(item.price)}</text>`,
            );
          });
          break;
        }
        // grade: rects manuais ou o MESMO auto-layout do editor (`layoutPieceProducts`)
        const manual = block.layout === 'manual' && items.every((i) => i.rect);
        const auto = manual
          ? null
          : layoutPieceProducts({
              areaRect: block.rect,
              width: W,
              height: H,
              itemIds: items.map((i) => i.id),
              featuredId: items.find((i) => i.featured)?.id ?? null,
            });
        const cells = items.map((item) =>
          pieceRectToPx(
            manual ? (item.rect as McPieceRect) : (auto as PieceLayoutResult).rects[item.id],
            W,
            H,
          ),
        );
        items.forEach((item, i) => parts.push(productCellSvg(cells[i], item, tag)));
        break;
      }
      case 'character': {
        const color = safeColor(block.panel?.color, '#FFFFFF');
        if (block.panel?.shape === 'circle') {
          const r = Math.round(Math.min(px.width, px.height) / 2);
          parts.push(
            `<circle cx="${px.x + px.width / 2}" cy="${px.y + px.height / 2}" r="${r}" fill="${color}"/>`,
          );
        } else {
          parts.push(
            `<rect x="${px.x}" y="${px.y}" width="${px.width}" height="${px.height}" rx="${block.panel?.shape === 'card' ? Math.round(px.width * 0.06) : 0}" fill="${color}"/>`,
          );
        }
        break;
      }
      default:
        break;
    }
  }
  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
  return { backgroundSvg, backgroundImage, overlaySvg, width: W, height: H };
}
