import type { FlyerProTemplateElement } from './flyer-pro.types';
import {
  analyzeSceneTemplate,
  toTemplateEntry,
  toTemplateSnapshot,
  zonesOf,
} from './flyer-pro-template-entry';
import {
  entryInput,
  faceRow,
  sectionRow,
  SCENE_ID,
  templateRow,
  TEMPLATE_BASE,
} from './flyer-pro-template-entry.testutil';

const entryOf = (options?: Parameters<typeof entryInput>[0]) =>
  toTemplateEntry(analyzeSceneTemplate(entryInput(options)));

describe('entrada do template do Encarte Pro (função pura)', () => {
  describe('cena pronta para uso', () => {
    it('face única 27x40: usable, sem motivo e sem face faltando', () => {
      const entry = entryOf();
      expect(entry).toEqual(
        expect.objectContaining({
          sceneId: SCENE_ID,
          name: 'Cena de teste',
          format: '27x40',
          fold: 'simple',
          layout: 'single',
          usable: true,
          unusableReason: null,
          missingFaces: [],
          sceneRevision: 5,
          updatedAt: '2026-11-13T02:32:08.690Z',
        }),
      );
      expect(entry?.faces.map((face) => face.key)).toEqual(['single']);
      expect(entry?.faces[0]).toEqual(expect.objectContaining({ index: 0, label: null }));
    });

    it('frente e verso: as duas faces em ordem de index, com rótulo e tamanho da face da cena', () => {
      const entry = entryOf({ scene: { layout: 'front_back' } });
      expect(entry).toEqual(expect.objectContaining({ usable: true, unusableReason: null }));
      expect(entry?.faces.map((face) => [face.key, face.index, face.label])).toEqual([
        ['front', 0, 'Frente'],
        ['back', 1, 'Verso'],
      ]);
      expect(entry?.faces.map((face) => [face.widthPx, face.heightPx])).toEqual([
        [2352, 3504],
        [2352, 3504],
      ]);
    });

    it('jornal 54x40: Externa e Interna, dobra dupla, páginas 2 ou 4', () => {
      const entry = entryOf({ scene: { formatId: 'folheto-54x40', layout: 'tabloid' } });
      expect(entry).toEqual(
        expect.objectContaining({
          format: '54x40',
          fold: 'double',
          layout: 'tabloid',
          pageOptions: [2, 4],
          defaultPageCount: 2,
          usable: true,
          unusableReason: null,
          missingFaces: [],
        }),
      );
      expect(entry?.faces.map((face) => [face.key, face.label])).toEqual([
        ['outer', 'Externa'],
        ['inner', 'Interna'],
      ]);
    });

    it('linhas das faces fora de ordem saem em ordem de index', () => {
      const input = entryInput({ scene: { layout: 'front_back' } });
      input.faces.reverse();
      const entry = toTemplateEntry(analyzeSceneTemplate(input));
      expect(entry?.faces.map((face) => face.key)).toEqual(['front', 'back']);
    });

    it('linha de face de uma chave que o layout não tem é ignorada', () => {
      const input = entryInput();
      input.faces.push(faceRow('inner'));
      const entry = toTemplateEntry(analyzeSceneTemplate(input));
      expect(entry?.faces.map((face) => face.key)).toEqual(['single']);
    });
  });

  describe('cena com face faltando', () => {
    it('frente e verso só com a Frente: FACE_MISSING e missingFaces ["back"]', () => {
      const entry = entryOf({ scene: { layout: 'front_back' }, ready: ['front'] });
      expect(entry).toEqual(
        expect.objectContaining({
          usable: false,
          unusableReason: 'FACE_MISSING',
          missingFaces: ['back'],
        }),
      );
      expect(entry?.faces.map((face) => face.key)).toEqual(['front']);
    });

    it('jornal só com a Externa: missingFaces ["inner"]', () => {
      const entry = entryOf({
        scene: { formatId: 'folheto-54x40', layout: 'tabloid' },
        ready: ['outer'],
      });
      expect(entry).toEqual(
        expect.objectContaining({
          usable: false,
          unusableReason: 'FACE_MISSING',
          missingFaces: ['inner'],
        }),
      );
      expect(entry?.faces.map((face) => face.key)).toEqual(['outer']);
    });

    it('Frente apagada e Verso pronto: missingFaces ["front"], só o back, e a miniatura da entrada nula', () => {
      const entry = entryOf({ scene: { layout: 'front_back' }, ready: ['back'] });
      expect(entry).toEqual(
        expect.objectContaining({
          usable: false,
          unusableReason: 'FACE_MISSING',
          missingFaces: ['front'],
          thumbnailUrl: null,
        }),
      );
      expect(entry?.faces.map((face) => face.key)).toEqual(['back']);
    });

    it('missingFaces segue a ordem do layout, mesmo sem nenhuma face pronta (a entrada não existe, o montador usa)', () => {
      const analysis = analyzeSceneTemplate(
        entryInput({ scene: { layout: 'front_back' }, ready: [] }),
      );
      expect(analysis.missingFaces).toEqual(['front', 'back']);
      expect(analysis.faces).toEqual([]);
      expect(toTemplateEntry(analysis)).toBeNull();
    });

    it('as páginas não dependem das faces prontas', () => {
      const single = entryOf();
      const incomplete = entryOf({ scene: { layout: 'front_back' }, ready: ['front'] });
      for (const entry of [single, incomplete]) {
        expect(entry?.pageOptions).toEqual([1, 2, 3, 4]);
        expect(entry?.defaultPageCount).toBe(1);
      }
    });
  });

  describe('layout e formato não suportados', () => {
    it('54x40 de face única com a face pronta: LAYOUT_UNSUPPORTED, sem face faltando e com a face em faces', () => {
      const input = entryInput({ scene: { formatId: 'folheto-54x40', layout: 'single' } });
      const analysis = analyzeSceneTemplate(input);
      expect(analysis.unsupported).toBe('LAYOUT');
      expect(toTemplateEntry(analysis)).toEqual(
        expect.objectContaining({
          usable: false,
          unusableReason: 'LAYOUT_UNSUPPORTED',
          missingFaces: [],
          format: '54x40',
        }),
      );
      expect(toTemplateEntry(analysis)?.faces.map((face) => face.key)).toEqual(['single']);
    });

    it('27x40 com o layout do jornal também é LAYOUT (o formato não aceita o layout)', () => {
      const analysis = analyzeSceneTemplate(
        entryInput({ scene: { layout: 'tabloid' }, faces: ['outer', 'inner'] }),
      );
      expect(analysis.unsupported).toBe('LAYOUT');
      expect(analysis.usable).toBe(false);
    });

    it('formato fora (20x27): FORMAT, sem entrada na lista', () => {
      const analysis = analyzeSceneTemplate(entryInput({ scene: { formatId: 'folheto-20x27' } }));
      expect(analysis.unsupported).toBe('FORMAT');
      expect(analysis.usable).toBe(false);
      expect(toTemplateEntry(analysis)).toBeNull();
    });
  });

  describe('face pronta', () => {
    it('face 0 sem templateId vale pelo approvedTemplateId da cena', () => {
      const input = entryInput({
        scene: { approvedTemplateId: 'tpl-approved' },
        faceOverrides: { single: { templateId: null } },
        ready: [],
      });
      input.templates.set('tpl-approved', templateRow('single', { id: 'tpl-approved' }));
      const entry = toTemplateEntry(analyzeSceneTemplate(input));
      expect(entry?.usable).toBe(true);
      expect(entry?.faces[0].templateId).toBe('tpl-approved');
    });

    it('o templateId da face vence o approvedTemplateId', () => {
      const input = entryInput({ scene: { approvedTemplateId: 'tpl-approved' } });
      input.templates.set('tpl-approved', templateRow('single', { id: 'tpl-approved' }));
      expect(toTemplateEntry(analyzeSceneTemplate(input))?.faces[0].templateId).toBe('tpl-single');
    });

    it('a reserva da cena só vale na face 0: o verso sem templateId não a usa', () => {
      const input = entryInput({
        scene: { layout: 'front_back', approvedTemplateId: 'tpl-front' },
        faceOverrides: { back: { templateId: null } },
        ready: ['front'],
      });
      const analysis = analyzeSceneTemplate(input);
      expect(analysis.missingFaces).toEqual(['back']);
      expect(analysis.faces.map((face) => face.key)).toEqual(['front']);
    });

    it('template sem o marcador de cena não conta', () => {
      const entry = entryOf({
        templateOverrides: {
          single: { source: { pictorialKey: 'p', fingerprint: 'f', syncedAt: 's' } },
        },
      });
      expect(entry).toBeNull();
    });

    it('template com outro tipo de origem não conta', () => {
      const entry = entryOf({
        templateOverrides: {
          single: {
            source: { kind: 'manual', pictorialKey: 'p', fingerprint: 'f', syncedAt: 's' },
          },
        },
      });
      expect(entry).toBeNull();
    });

    it('template sem configuração de origem não conta', () => {
      expect(entryOf({ templateOverrides: { single: { source: null } } })).toBeNull();
    });

    it('template apontado que não existe mais não conta', () => {
      expect(entryOf({ ready: [] })).toBeNull();
    });
  });

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

  describe('campos da face e da entrada', () => {
    it('artUrl, miniatura, chaves e hora da projeção vêm do template, como gravados', () => {
      const [front] = entryOf({ scene: { layout: 'front_back' } })?.faces ?? [];
      expect(front).toEqual(
        expect.objectContaining({
          templateId: 'tpl-front',
          artUrl: `${TEMPLATE_BASE}/front/full.jpg`,
          thumbnailUrl: `${TEMPLATE_BASE}/front/thumbnail.jpg`,
          pictorialKey: 'pictorial-front',
          fingerprint: 'fingerprint-front',
          syncedAt: '2026-11-13T02:29:10.437Z',
        }),
      );
    });

    it('a miniatura da entrada é a da face 0', () => {
      const entry = entryOf({ scene: { layout: 'front_back' } });
      expect(entry?.thumbnailUrl).toBe(`${TEMPLATE_BASE}/front/thumbnail.jpg`);
    });

    it('template sem miniatura: a da face e a da entrada são nulas', () => {
      const entry = entryOf({ templateOverrides: { single: { thumbnailUrl: null } } });
      expect(entry?.faces[0].thumbnailUrl).toBeNull();
      expect(entry?.thumbnailUrl).toBeNull();
    });

    it('nenhuma chave da configuração vai para a saída', () => {
      const entry = entryOf({ scene: { layout: 'front_back' } });
      const keys = new Set<string>();
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) {
            keys.add(key);
            walk(item);
          }
        }
      };
      walk(entry);
      expect(keys).not.toContain('configuration');
      expect(keys).not.toContain('bodyBackground');
      expect(keys).not.toContain('source');
      expect(keys).not.toContain('background');
    });

    it('a entrada traz exatamente os campos do contrato', () => {
      const entry = entryOf();
      expect(Object.keys(entry ?? {}).sort()).toEqual(
        [
          'defaultPageCount',
          'faces',
          'fold',
          'format',
          'layout',
          'missingFaces',
          'name',
          'pageOptions',
          'sceneId',
          'sceneRevision',
          'thumbnailUrl',
          'unusableReason',
          'updatedAt',
          'usable',
        ].sort(),
      );
      expect(Object.keys(entry?.faces[0] ?? {}).sort()).toEqual(
        [
          'artUrl',
          'fingerprint',
          'footer',
          'header',
          'heightPx',
          'index',
          'key',
          'label',
          'pictorialKey',
          'syncedAt',
          'templateId',
          'thumbnailUrl',
          'widthPx',
          'zones',
        ].sort(),
      );
    });
  });

  describe('cópia (templateSnapshot)', () => {
    const capturedAt = '2026-11-16T10:00:00.000Z';

    it('traz v, cena, formato, dobra, layout, faces, revisão e hora, e as faces são as da entrada', () => {
      const analysis = analyzeSceneTemplate(entryInput({ scene: { layout: 'front_back' } }));
      if (analysis.unsupported) throw new Error('formato fora');
      const snapshot = toTemplateSnapshot(analysis, capturedAt);
      expect(snapshot).toEqual({
        v: 1,
        sceneId: SCENE_ID,
        name: 'Cena de teste',
        format: '27x40',
        fold: 'simple',
        layout: 'front_back',
        faces: toTemplateEntry(analysis)?.faces,
        sceneRevision: 5,
        capturedAt,
      });
    });

    it('não traz os campos só da lista', () => {
      const analysis = analyzeSceneTemplate(entryInput());
      if (analysis.unsupported) throw new Error('formato fora');
      const keys = Object.keys(toTemplateSnapshot(analysis, capturedAt));
      for (const key of [
        'pageOptions',
        'defaultPageCount',
        'usable',
        'unusableReason',
        'missingFaces',
        'thumbnailUrl',
        'updatedAt',
      ]) {
        expect(keys).not.toContain(key);
      }
    });
  });
});
