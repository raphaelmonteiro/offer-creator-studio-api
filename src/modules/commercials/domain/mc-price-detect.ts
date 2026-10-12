import {
  artBoxToOutputWindow,
  McArtTextDetection,
  windowPxToFractions,
} from './mc-talking-art-window';

/**
 * Detecção de PREÇOS na arte de fundo (tarefa 4.7, spec "Janela sobre
 * preço"): prompt e parser do Gemini visão, cenários do modo mock e a
 * conversão das caixas (frações da ARTE) para frações do QUADRO DE SAÍDA que
 * `windowCoversPriceWarning` compara com a janela. Tudo puro; o I/O (arte no
 * disco, chamada à visão, cache no asset) é do `McWindowPriceService`.
 */

/** Versão do contrato da detecção (prompt + parser): mudar invalida o cache gravado nos assets. */
export const MC_PRICE_DETECT_VERSION = 1;

/** Teto de detecções aceitas de uma resposta (encarte com muitas ofertas). */
export const MC_PRICE_DETECT_MAX = 60;

export const MC_PRICE_DETECT_PROMPT = [
  'You are reading a retail promotional image (a supermarket flyer page or a social media post).',
  'Find EVERY price shown in it: amounts such as "R$ 9,99", "9,99", "R$ 12", "por 4,49",',
  '"2 por R$ 10,00", "de 12,90 por 9,90", including the large price tags of each offer.',
  'Answer ONLY with compact JSON: {"prices": [{"text": "<price exactly as written>",',
  '"box_2d": [ymin, xmin, ymax, xmax], "confidence": 0.0-1.0}]}.',
  '"box_2d": the tight bounding box of that price (digits, currency and cents together),',
  'integers normalized to 0-1000 with the origin at the top-left corner.',
  'Return {"prices": []} when there is no price. Do not return product names, dates,',
  'phone numbers, percentages without a price, logos or addresses.',
].join(' ');

/** Cenários do modo mock (`MC_KIT_PROVIDER=mock`): `MC_PRICE_DETECT_MOCK=none|overlap|error`. */
export const MC_PRICE_DETECT_MOCK_SCENARIOS = ['none', 'overlap', 'error'] as const;
export type McPriceDetectMockScenario = (typeof MC_PRICE_DETECT_MOCK_SCENARIOS)[number];

/**
 * Preço sintético do cenário `overlap`, em frações da ARTE: lado direito,
 * meia altura — cobre a janela default (canto inferior direito da área
 * segura) em 9:16, 4:5, 1:1 → 9:16 e 16:9, e deixa os presets da esquerda
 * livres (sugestão da UI).
 */
export const MC_PRICE_DETECT_MOCK_PRICE: McArtTextDetection = {
  text: 'R$ 9,99',
  bbox: { x: 0.58, y: 0.45, w: 0.38, h: 0.35 },
  kind: 'price',
  confidence: 0.95,
};

/** Texto que NÃO é preço (título da arte) — o filtro do aviso o ignora. */
export const MC_PRICE_DETECT_MOCK_TITLE: McArtTextDetection = {
  text: 'OFERTAS DA SEMANA',
  bbox: { x: 0.1, y: 0.03, w: 0.8, h: 0.08 },
  kind: 'text',
  confidence: 0.9,
};

export function parseMockScenario(value: string | undefined): McPriceDetectMockScenario {
  const text = (value ?? '').trim().toLowerCase();
  return (MC_PRICE_DETECT_MOCK_SCENARIOS as readonly string[]).includes(text)
    ? (text as McPriceDetectMockScenario)
    : 'none';
}

/** Detecções determinísticas do mock (frações da arte). `error` não chega aqui: simula indisponibilidade. */
export function mockPriceDetections(scenario: McPriceDetectMockScenario): McArtTextDetection[] {
  if (scenario === 'overlap') {
    return [
      { ...MC_PRICE_DETECT_MOCK_PRICE, bbox: { ...MC_PRICE_DETECT_MOCK_PRICE.bbox } },
      { ...MC_PRICE_DETECT_MOCK_TITLE, bbox: { ...MC_PRICE_DETECT_MOCK_TITLE.bbox } },
    ];
  }
  return [];
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Number(n.toFixed(4));

/** Caixa em frações, presa ao quadro; tamanho nulo → null. */
function clampBox(box: { x: number; y: number; w: number; h: number }) {
  const x0 = clamp01(box.x);
  const y0 = clamp01(box.y);
  const x1 = clamp01(box.x + box.w);
  const y1 = clamp01(box.y + box.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0) };
}

/** `box_2d` [ymin, xmin, ymax, xmax] (0–1000, ou 0–1 já normalizado) ou `bbox` {x,y,w,h} → caixa. */
function boxOf(item: Record<string, unknown>) {
  const raw = item.box_2d;
  if (Array.isArray(raw) && raw.length === 4) {
    const nums = raw.map(finite);
    if (nums.every((n) => n != null)) {
      const values = nums as number[];
      const scale = values.every((n) => n <= 1) ? 1 : 1000;
      const [ymin, xmin, ymax, xmax] = values.map((n) => n / scale);
      return clampBox({
        x: Math.min(xmin, xmax),
        y: Math.min(ymin, ymax),
        w: Math.abs(xmax - xmin),
        h: Math.abs(ymax - ymin),
      });
    }
  }
  const bbox = item.bbox as Record<string, unknown> | undefined;
  if (bbox && typeof bbox === 'object') {
    const [x, y, w, h] = [bbox.x, bbox.y, bbox.w, bbox.h].map(finite);
    if (x != null && y != null && w != null && h != null) return clampBox({ x, y, w, h });
  }
  return null;
}

/**
 * Parse tolerante da resposta (o modelo às vezes cerca com ```json): primeiro
 * objeto JSON do texto com `prices` em lista. Itens sem caixa válida são
 * descartados; texto vazio vira "preço" (a pergunta foi só por preços).
 * Resposta sem `prices` → null (o service trata como indisponível).
 */
export function parsePriceDetectResponse(text: string): McArtTextDetection[] | null {
  const match = (text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.prices)) return null;
  const detections: McArtTextDetection[] = [];
  for (const raw of parsed.prices.slice(0, MC_PRICE_DETECT_MAX)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const bbox = boxOf(item);
    if (!bbox) continue;
    const confidence = finite(item.confidence);
    detections.push({
      text: typeof item.text === 'string' ? item.text.slice(0, 40) : '',
      bbox,
      kind: 'price',
      confidence: confidence == null ? 0.8 : clamp01(confidence),
    });
  }
  return detections;
}

/**
 * Caixas em frações da ARTE → frações do QUADRO DE SAÍDA, pela mesma
 * transformação contain-fit do compose (a arte inteira, centrada, faixas de
 * preenchimento nas sobras): é o espaço da janela do roteiro.
 */
export function detectionsToOutputFrame(
  detections: McArtTextDetection[],
  art: { width: number; height: number },
  out: { width: number; height: number },
): McArtTextDetection[] {
  return detections.map((d) => ({
    ...d,
    bbox: windowPxToFractions(
      artBoxToOutputWindow(d.bbox, art.width, art.height, out.width, out.height),
      out.width,
      out.height,
    ),
  }));
}
