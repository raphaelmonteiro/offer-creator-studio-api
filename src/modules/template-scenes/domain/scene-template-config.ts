import { SceneFormatSpec, computeSceneZones } from './scene-formats';
import { SceneZones } from './scene.types';
import {
  SceneTemplateConfiguration,
  TemplateElement,
  TemplateImageBackground,
  TemplateImageUrls,
  TemplateSceneSource,
  TemplateSection,
  TemplateSolidBackground,
} from './scene-template.types';

const imageBackground = (imageUrl: string): TemplateImageBackground => ({
  type: 'image',
  imageUrl,
  imageSize: 'cover',
  imagePosition: 'center',
  imageOpacity: 100,
});

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export interface SectionBands {
  headerPx: number;
  footerPx: number;
}

/**
 * Fatias do cabeçalho e do rodapé na altura nativa da master (PV-2): as frações das zonas aplicadas sobre a altura,
 * arredondadas. Zona de altura 0 (a face não a tem) dá 0 px: nenhuma fatia.
 */
export function zoneSectionBands(zones: SceneZones, heightPx: number): SectionBands {
  return {
    headerPx: Math.round(heightPx * zones.header.h),
    footerPx: Math.round(heightPx * zones.footer.h),
  };
}

/** As fatias da face única do formato (as zonas de `computeSceneZones`). */
export function sectionBands(format: SceneFormatSpec, heightPx: number): SectionBands {
  return zoneSectionBands(computeSceneZones(format), heightPx);
}

const NO_SECTION_BACKGROUND: TemplateSolidBackground = { type: 'solid', color: 'transparent' };

function section(
  id: 'header' | 'footer',
  input: {
    format: SceneFormatSpec;
    fraction: number;
    imageUrl?: string;
    elements: TemplateElement[];
  },
): TemplateSection {
  const base = {
    id,
    name: id === 'header' ? 'Header' : 'Footer',
    widthCm: input.format.artWidthCm,
  };
  // PV-11: zona que a face não tem vira seção de altura 0, sem imagem e sem elementos; o editor já trata altura 0.
  if (input.fraction <= 0 || !input.imageUrl) {
    return { ...base, heightCm: 0, background: NO_SECTION_BACKGROUND, elements: [] };
  }
  return {
    ...base,
    heightCm: round4(input.fraction * input.format.artHeightCm),
    background: imageBackground(input.imageUrl),
    elements: input.elements,
  };
}

export interface ConfigurationInput {
  format: SceneFormatSpec;
  /** Zonas da face; sem elas, as do formato (face única). */
  zones?: SceneZones;
  urls: TemplateImageUrls;
  header: TemplateElement[];
  footer: TemplateElement[];
  source: TemplateSceneSource;
}

/**
 * `templates.configuration` do template de cena. O fundo da página é a imagem inteira (PV-1): o editor pinta
 * `bodyBackground` no artboard todo com `cover` e desenha o cabeçalho e o rodapé por cima.
 */
export function buildTemplateConfiguration(input: ConfigurationInput): SceneTemplateConfiguration {
  const zones = input.zones ?? computeSceneZones(input.format);
  return {
    format: input.format.id,
    header: section('header', {
      format: input.format,
      fraction: zones.header.h,
      imageUrl: input.urls.header,
      elements: input.header,
    }),
    footer: section('footer', {
      format: input.format,
      fraction: zones.footer.h,
      imageUrl: input.urls.footer,
      elements: input.footer,
    }),
    bodyBackground: imageBackground(input.urls.full),
    source: input.source,
  };
}
