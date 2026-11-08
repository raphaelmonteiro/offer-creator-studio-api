import { SceneFormatSpec, computeSceneZones } from './scene-formats';
import {
  SceneTemplateConfiguration,
  TemplateElement,
  TemplateImageBackground,
  TemplateImageUrls,
  TemplateSceneSource,
  TemplateSection,
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
 * Fatias do cabeçalho e do rodapé na altura nativa da master (PV-2): as frações de `computeSceneZones` aplicadas
 * sobre a altura, arredondadas.
 */
export function sectionBands(format: SceneFormatSpec, heightPx: number): SectionBands {
  const zones = computeSceneZones(format);
  return {
    headerPx: Math.round(heightPx * zones.header.h),
    footerPx: Math.round(heightPx * zones.footer.h),
  };
}

function section(
  id: 'header' | 'footer',
  input: {
    format: SceneFormatSpec;
    fraction: number;
    imageUrl: string;
    elements: TemplateElement[];
  },
): TemplateSection {
  return {
    id,
    name: id === 'header' ? 'Header' : 'Footer',
    widthCm: input.format.artWidthCm,
    heightCm: round4(input.fraction * input.format.artHeightCm),
    background: imageBackground(input.imageUrl),
    elements: input.elements,
  };
}

export interface ConfigurationInput {
  format: SceneFormatSpec;
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
  const zones = computeSceneZones(input.format);
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
