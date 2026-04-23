import { LayerBodyBackgroundDto, LayerElementDto } from '../dto/template-layers-generate.dto';
import {
  normalizeCanvasElementRecord,
  normalizeLayerBackgrounds,
  normalizeLayerElements,
  normalizeTemplateConfigurationLayout,
} from './ai-layout.util';

const bounds = {
  canvasWidthPx: 1000,
  headerHeightPx: 300,
  footerHeightPx: 120,
};

describe('ai-layout.util', () => {
  describe('normalizeLayerElements', () => {
    it('clamps element dimensions, coordinates and zIndex to section bounds', () => {
      const input: LayerElementDto[] = [
        {
          id: 'hero',
          imageUrl: '/hero.png',
          prompt: 'hero',
          x: -40,
          y: 500,
          width: 2000,
          height: 2,
          section: 'header',
          zIndex: 0,
        },
      ];

      const result = normalizeLayerElements(input, bounds);

      expect(result.elements[0]).toMatchObject({
        x: 0,
        y: 264,
        width: 850,
        height: 36,
        section: 'header',
        zIndex: 1,
      });
      expect(result.adjustments.map((item) => item.field)).toEqual(
        expect.arrayContaining(['x', 'y', 'width', 'height', 'zIndex']),
      );
    });

    it('falls back invalid sections to header and keeps elements inside bounds', () => {
      const input = [
        {
          id: 'invalid-section',
          imageUrl: '/item.png',
          prompt: 'item',
          x: 990,
          y: 10,
          width: 200,
          height: 100,
          section: 'body',
          zIndex: 150,
        },
      ] as unknown as LayerElementDto[];

      const result = normalizeLayerElements(input, bounds);

      expect(result.elements[0].section).toBe('header');
      expect(result.elements[0].x).toBe(800);
      expect(result.elements[0].zIndex).toBe(100);
      expect(result.adjustments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'section', reason: 'invalid-section' }),
        ]),
      );
    });
  });

  describe('normalizeLayerBackgrounds', () => {
    it('normalizes hex colors, gradient angle and footer background type', () => {
      const bodyBackground = {
        type: 'gradient',
        gradientStart: '#abc',
        gradientEnd: 'invalid',
        gradientAngle: 999,
      } as LayerBodyBackgroundDto;
      const footerBackground = {
        type: 'gradient',
        color: 'not-a-color',
      } as unknown as LayerBodyBackgroundDto;

      const result = normalizeLayerBackgrounds(bodyBackground, footerBackground);

      expect(result.bodyBackground).toMatchObject({
        type: 'gradient',
        gradientStart: '#AABBCC',
        gradientEnd: '#F3F4F6',
        gradientAngle: 360,
      });
      expect(result.footerBackground).toEqual({
        type: 'solid',
        color: '#111827',
      });
      expect(result.adjustments.map((item) => item.field)).toEqual(
        expect.arrayContaining(['gradientEnd', 'gradientAngle', 'type', 'color']),
      );
    });
  });

  describe('normalizeTemplateConfigurationLayout', () => {
    it('normalizes generated template sections without changing the public shape', () => {
      const configuration = {
        header: {
          background: { type: 'solid', color: '#abc' },
          elements: [
            {
              id: 'title',
              type: 'text',
              x: -10,
              y: -20,
              width: 9999,
              height: 1,
              zIndex: -1,
            },
          ],
        },
        footer: {
          background: { type: 'gradient', color: '#000000' },
          elements: [],
        },
        bodyBackground: { type: 'solid', color: 'invalid' },
      };

      const result = normalizeTemplateConfigurationLayout(configuration, bounds);
      const header = result.configuration.header as Record<string, unknown>;
      const headerElements = header.elements as Record<string, unknown>[];

      expect(header.background).toMatchObject({ type: 'solid', color: '#AABBCC' });
      expect(headerElements[0]).toMatchObject({
        x: 0,
        y: 0,
        width: 850,
        height: 36,
        zIndex: 1,
      });
      expect(result.configuration.bodyBackground).toMatchObject({
        type: 'solid',
        color: '#FFFFFF',
      });
      expect(result.adjustments.length).toBeGreaterThan(0);
    });
  });

  describe('normalizeCanvasElementRecord', () => {
    it('normalizes a single canvas element record for incremental actions', () => {
      const result = normalizeCanvasElementRecord(
        { id: 'new', x: 1200, y: 999, width: 10, height: 999, zIndex: 0 },
        bounds,
        'footer',
        5,
      );

      expect(result.element).toMatchObject({
        x: 960,
        y: 6,
        width: 40,
        height: 114,
        zIndex: 1,
      });
      expect(result.adjustments.length).toBeGreaterThan(0);
    });
  });
});
