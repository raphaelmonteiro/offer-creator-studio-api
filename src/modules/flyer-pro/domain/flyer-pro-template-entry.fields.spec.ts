import {
  analyzeSceneTemplate,
  toTemplateEntry,
  toTemplateSnapshot,
} from './flyer-pro-template-entry';
import { entryInput, entryOf, SCENE_ID, TEMPLATE_BASE } from './flyer-pro-template-entry.testutil';

describe('entrada do template do Encarte Pro: campos e cópia', () => {
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
