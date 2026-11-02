import { Drill } from './drill-util';
import { nativeSize } from './formats';
import { loadCases, missingRegions, validateCases } from './plan';
import type { CasesFile } from './types';

const EXPECTED: Record<string, string> = {
  'folheto-27x54': '1920x3840',
  'folheto-55x36': '3520x2336',
  'revista-20x26.5': '2496x3280',
  'folheto-27x40': '2352x3504',
  'folheto-54x30': '3840x2128',
};

export function runPlanDrills(d: Drill): void {
  d.section('Cenas na proporção nativa e validação do plano');
  const cases = loadCases();
  const result = validateCases(cases);
  d.check('cases.json sem erros', result.errors.length === 0, result.errors.join('; '));
  for (const scene of cases.scenes) {
    const size = result.sizes[scene.id];
    const got = `${size.width}x${size.height}`;
    d.check(
      `${scene.id} ${scene.formatId} = ${EXPECTED[scene.formatId]}`,
      got === EXPECTED[scene.formatId],
      got,
    );
    d.check(
      `${scene.id}: lados múltiplos de 16 e área no intervalo`,
      size.width % 16 === 0 &&
        size.height % 16 === 0 &&
        size.width * size.height >= 655_360 &&
        size.width * size.height <= 8_294_400,
    );
  }
  const tall: CasesFile = {
    ...cases,
    scenes: [{ id: 'T1', formatId: 'tira-10x50', prompt: 'x' }],
    edits: [],
    promotions: [],
    marginSubset: [],
  };
  const bad = validateCases(tall, {
    'tira-10x50': { id: 'tira-10x50', artWidthCm: 10, artHeightCm: 50, headerCm: 3, footerCm: 2 },
  });
  d.check(
    'formato fora de 1:3 a 3:1 é recusado antes de qualquer chamada',
    bad.errors.some((e) => /1:3 a 3:1/.test(e)),
  );
  d.check(
    'nativeSize recusa proporção 4:1',
    (() => {
      try {
        nativeSize(40, 10);
        return false;
      } catch {
        return true;
      }
    })(),
  );
  const unmarked: CasesFile = {
    ...cases,
    edits: [
      {
        id: 'X1',
        block: 'A',
        sceneId: 'C1',
        target: 't',
        prompt: 'p',
        kind: 'k',
        shapeKind: 'rect',
      },
    ],
    promotions: [],
  };
  d.check('caso sem região é listado pelo plan', missingRegions(unmarked).join() === 'X1');
}
