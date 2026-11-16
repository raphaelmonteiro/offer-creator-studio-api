import { analyzeSceneTemplate, toTemplateEntry } from './flyer-pro-template-entry';
import {
  entryInput,
  entryOf,
  faceRow,
  SCENE_ID,
  templateRow,
} from './flyer-pro-template-entry.testutil';

describe('entrada do template do Encarte Pro: faces, prontidão e suporte', () => {
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
});
