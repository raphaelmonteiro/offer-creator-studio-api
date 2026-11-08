import { isLayer } from './scene-template-keys';
import { TemplateElement } from './scene-template.types';
import { SceneElement } from './scene.types';

/** Resolução de prévia do editor de encartes (`PREVIEW_DPI` em `frontend/src/types/template.ts`). */
const PREVIEW_DPI = 72;
const TEXT_LINE_HEIGHT = 1.25;
const DEFAULT_FONT_SIZE = 7;

export const cmToPreviewPixels = (cm: number): number => Math.round((cm / 2.54) * PREVIEW_DPI);

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface LayerMappingInput {
  elements: SceneElement[];
  /** Tamanho nativo da master, em px. */
  widthPx: number;
  heightPx: number;
  artWidthCm: number;
  /** Altura das fatias do cabeçalho e do rodapé na master, em px (PV-2). */
  headerPx: number;
  footerPx: number;
  /** URL da cópia da logo no template; sem ela a camada fica de fora. */
  logoUrlOf: (assetId: string) => string | undefined;
}

export interface SectionElements {
  header: TemplateElement[];
  footer: TemplateElement[];
}

/** Seção que contém o centro da camada; `null` no miolo, que o template não tem (PV-5). */
export function sectionOfCenter(
  centerY: number,
  heightPx: number,
  bands: { headerPx: number; footerPx: number },
): 'header' | 'footer' | null {
  const y = centerY * heightPx;
  if (y < bands.headerPx) return 'header';
  if (y >= heightPx - bands.footerPx) return 'footer';
  return null;
}

/**
 * Logo e texto da versão em `elements` do cabeçalho e do rodapé, em px de prévia a 72 DPI (PV-5). A escala é a da
 * largura (master → prévia) nos dois eixos, então a posição na seção bate com a da cena. A camada com centro no
 * miolo fica fora, sem aviso (D-11).
 */
export function mapLayersToSections(input: LayerMappingInput): SectionElements {
  const previewWidth = cmToPreviewPixels(input.artWidthCm);
  const scale = previewWidth / input.widthPx;
  const tops = { header: 0, footer: input.heightPx - input.footerPx };
  const result: SectionElements = { header: [], footer: [] };
  for (const element of input.elements.filter(isLayer)) {
    const section = sectionOfCenter(element.y, input.heightPx, input);
    if (!section) continue;
    const boxWidth = element.w * input.widthPx;
    const boxHeight = boxWidth / element.aspect;
    const box = {
      id: element.id,
      x: round2((element.x * input.widthPx - boxWidth / 2) * scale),
      y: round2((element.y * input.heightPx - boxHeight / 2 - tops[section]) * scale),
      width: round2(boxWidth * scale),
      height: round2(boxHeight * scale),
      zIndex: element.z,
      rotation: element.rotation,
    };
    if (element.kind === 'text') {
      if (!element.text) continue;
      result[section].push({
        ...box,
        type: 'text',
        content: element.text,
        fontFamily: element.fontFamily ?? 'Georgia',
        fontSize: round2(((element.fontSize ?? DEFAULT_FONT_SIZE) * previewWidth) / 100),
        fontWeight: 'normal',
        color: element.color ?? '#ffffff',
        textAlign: 'center',
        lineHeight: TEXT_LINE_HEIGHT,
      });
      continue;
    }
    const src = element.assetId ? input.logoUrlOf(element.assetId) : undefined;
    if (src) {
      result[section].push({ ...box, type: 'image', src, alt: element.name, objectFit: 'contain' });
    }
  }
  return result;
}
