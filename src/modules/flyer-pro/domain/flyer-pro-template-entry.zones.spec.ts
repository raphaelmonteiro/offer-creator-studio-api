import type { FlyerProTemplateElement } from './flyer-pro.types';
import { analyzeSceneTemplate, toTemplateEntry, zonesOf } from './flyer-pro-template-entry';
import {
  entryInput,
  entryOf,
  sectionRow,
  TEMPLATE_BASE,
} from './flyer-pro-template-entry.testutil';

describe('entrada do template do Encarte Pro: zonas e faixas', () => {
  describe('zonas pela projeção', () => {
    it.each([
      ['cabeçalho de 6,15 cm numa arte de 41 cm', 6.15, 15],
      ['cabeçalho da capa de 10 cm (10,25 na arte de 41)', 10.25, 25],
      ['7 cm arredondados em 2 casas', 7, 17.07],
    ])('%s: header até %p%%', (_name, heightCm, to) => {
      const entry = entryOf({
        templateOverrides: { single: { header: sectionRow('single/header', heightCm) } },
      });
      expect(entry?.faces[0].zones.header).toEqual({ from: 0, to });
    });

    it('rodapé de 4,1 cm numa arte de 41 cm começa em 90 e vai a 100', () => {
      expect(entryOf()?.faces[0].zones).toEqual({
        header: { from: 0, to: 15 },
        footer: { from: 90, to: 100 },
      });
    });

    it('rodapé de 7 cm numa arte de 41 cm começa em 82,93', () => {
      expect(zonesOf(null, sectionRow('f', 7), 41).footer).toEqual({ from: 82.93, to: 100 });
    });

    it('seção de altura 0 vira zona vazia e faixa nula (frente sem rodapé, verso sem cabeçalho, interna sem nenhuma)', () => {
      const entry = entryOf({ scene: { layout: 'front_back' } });
      const [front, back] = entry?.faces ?? [];
      expect(front.zones.footer).toEqual({ from: 100, to: 100 });
      expect(front.footer).toBeNull();
      expect(back.zones.header).toEqual({ from: 0, to: 0 });
      expect(back.header).toBeNull();
      const tabloid = entryOf({ scene: { formatId: 'folheto-54x40', layout: 'tabloid' } });
      expect(tabloid?.faces[1].zones).toEqual({
        header: { from: 0, to: 0 },
        footer: { from: 100, to: 100 },
      });
      expect(tabloid?.faces[1].header).toBeNull();
      expect(tabloid?.faces[1].footer).toBeNull();
    });

    it('zonas guardadas na face da cena não valem: vale a projeção', () => {
      const input = entryInput({
        templateOverrides: { single: { header: sectionRow('single/header', 10.25) } },
      });
      input.faces[0] = { ...input.faces[0], zones: { header: { h: 0.15 } } } as never;
      expect(toTemplateEntry(analyzeSceneTemplate(input))?.faces[0].zones.header).toEqual({
        from: 0,
        to: 25,
      });
    });

    it('usa a altura da arte da cena', () => {
      const entry = entryOf({
        scene: { formatId: 'folheto-54x40', layout: 'tabloid', artHeightCm: 20.5 },
        templateOverrides: { outer: { header: sectionRow('outer/header', 6.15) } },
      });
      expect(entry?.faces[0].zones.header).toEqual({ from: 0, to: 30 });
    });
  });

  describe('faixas e camadas', () => {
    it('faixa sem camadas: a fatia, a largura com sangria, a altura e elements vazio', () => {
      const [front] = entryOf({ scene: { layout: 'front_back' } })?.faces ?? [];
      expect(front.header).toEqual({
        imageUrl: `${TEMPLATE_BASE}/front/header.jpg`,
        widthCm: 27.5,
        heightCm: 6.15,
        elements: [],
      });
      expect(front.footer).toBeNull();
    });

    const logo: FlyerProTemplateElement = {
      type: 'image',
      id: 'logo-1',
      src: 'http://cdn.test/uploads/templates/scene-x/logos/a.png',
      alt: 'Logo',
      objectFit: 'contain',
      x: 12.5,
      y: 3.25,
      width: 80,
      height: 40.5,
      zIndex: 2,
      rotation: -4,
    };
    const text: FlyerProTemplateElement = {
      type: 'text',
      id: 'texto-1',
      content: 'Ofertas da semana',
      fontSize: 14.5,
      fontFamily: 'Georgia',
      fontWeight: 'normal',
      color: '#ffffff',
      textAlign: 'center',
      lineHeight: 1.25,
      x: 4,
      y: 6,
      width: 120,
      height: 20,
      zIndex: 3,
      rotation: 0,
    };

    it('logo no cabeçalho e texto no rodapé são copiados sem perda', () => {
      const [single] =
        entryOf({
          templateOverrides: {
            single: {
              header: sectionRow('single/header', 6.15, { elements: [logo] }),
              footer: sectionRow('single/footer', 4.1, { elements: [text] }),
            },
          },
        })?.faces ?? [];
      expect(single.header?.elements).toEqual([logo]);
      expect(single.footer?.elements).toEqual([text]);
    });
  });
});
