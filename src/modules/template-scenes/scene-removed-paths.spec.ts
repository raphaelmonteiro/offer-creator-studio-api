import * as fs from 'fs';
import * as path from 'path';
import { listSourceFiles } from '../../common/config/source-files.testutil';

const SRC = path.join(__dirname, '..', '..');

/** Nomes do caminho de edição recortada e de recomposição, que saíram com a conversa (D-22, D-25, D-26, D-33). */
const REMOVED = [
  'scene-recompose',
  'SceneImageService',
  'RECOMPOSE_MISMATCH',
  'marginDiffRatio',
  'seamSsim',
  'recomposeRegion',
  'paddedRegion',
  'renderEditMask',
  'authorizedRegion',
  'editImageWithMask',
  'openai-image-masked-edit',
  'scene-edit.handler',
  'scene-intent',
  'SceneIntentService',
  'OpenAiIntentService',
  'scene-operation.classifier',
  'scene-request-text',
  'scene-request-parse',
  'scene-message-planner',
  'scene-confirmation',
  'scene-integrate',
  'scene-layer.handler',
  'scene-target-source',
  'scene-element-image',
  'scene-add-element',
  'generateTransparent(',
  'notApplied',
  'TEMPLATE_SCENE_FEATHER_PX',
  'TEMPLATE_SCENE_MARGIN_RATIO',
  'TEMPLATE_SCENE_INSET_PX',
  'TEMPLATE_SCENE_NOOP_THRESHOLD',
  'TEMPLATE_SCENE_INTENT_',
  // D-51: o detector de escrita saiu (a medida 1.45 mostrou que só causava falsa recusa).
  'scene-painted-detector',
  'scene-removal-mask',
  'scene-director-painted',
  'PAINTED_PROMISE',
  '#plano-pintado',
  'promptableTexts',
  'enforcePaintedRefusal',
  'Não pinto',
  'PAINTED_QUESTION',
  'painted_question',
  'layerReply',
  'askedAboutImageReply',
  'buildGlobalPrompt',
  'buildRedrawPrompt',
];

const REMOVED_FILES = [
  'modules/template-scenes/services/scene-image.service.ts',
  'modules/template-scenes/services/scene-recompose.ts',
  'modules/template-scenes/services/scene-metrics.ts',
  'modules/template-scenes/domain/scene-region.ts',
  'modules/template-scenes/domain/scene-intent.ts',
  'modules/template-scenes/domain/scene-intent.eval.json',
  'modules/template-scenes/domain/scene-operation.classifier.ts',
  'modules/template-scenes/domain/scene-request-text.ts',
  'modules/template-scenes/processors/scene-edit.handler.ts',
  'modules/template-scenes/processors/scene-add-element.handler.ts',
  'modules/template-scenes/processors/scene-layer.handler.ts',
  'modules/template-scenes/providers/mock-scene-intent.client.ts',
  'modules/ai/openai-intent.service.ts',
  'modules/ai/openai-image-masked-edit.ts',
  'modules/template-scenes/domain/scene-painted-detector.ts',
  'modules/template-scenes/domain/scene-removal-mask.ts',
  'modules/template-scenes/domain/scene-director-painted.ts',
  'modules/template-scenes/processors/scene-director.painted.spec.ts',
  'modules/template-scenes/processors/scene-director.regression.spec.ts',
  'modules/template-scenes/domain/__fixtures__/director-plans-1.42-1.43.json',
];

/** Os `.ts` sob `modules/<pasta>` (ou `shared`), testes inclusos, menos este arquivo, com `rel` relativo a `src/`. */
function sourcesUnder(...dir: string[]) {
  return listSourceFiles(path.join(SRC, ...dir), {
    root: SRC,
    skipFile: (name) => name === 'scene-removed-paths.spec.ts',
  });
}

describe('Nenhum caminho de recomposição', () => {
  const files = [
    ...sourcesUnder('modules', 'template-scenes'),
    ...sourcesUnder('modules', 'ai'),
    ...sourcesUnder('shared'),
  ];

  it('os arquivos da recomposição e da edição recortada não existem mais', () => {
    for (const file of REMOVED_FILES) {
      expect({ file, exists: fs.existsSync(path.join(SRC, file)) }).toEqual({
        file,
        exists: false,
      });
    }
  });

  it.each(REMOVED)('nenhum arquivo de src/ cita "%s"', (name) => {
    const hits = files.filter((file) => file.text.includes(name));
    expect(hits.map((file) => file.rel)).toEqual([]);
  });

  it('o código da cena não envia mask ao provedor de imagem', () => {
    const provider = fs.readFileSync(
      path.join(SRC, 'modules/template-scenes/providers/openai-scene-image.provider.ts'),
      'utf8',
    );
    expect(provider).not.toMatch(/\bmask\b/);
    const port = fs.readFileSync(
      path.join(SRC, 'modules/template-scenes/providers/scene-image-provider.ts'),
      'utf8',
    );
    expect(port).not.toMatch(/\bpaintMask\b|\bmask\?:/);
  });

  it('a morfologia fica: os comerciais a usam (mc-cutout-*), com a mesma semântica', () => {
    expect(fs.existsSync(path.join(SRC, 'shared/image/morphology.ts'))).toBe(true);
    const users = sourcesUnder('modules', 'commercials').filter((file) =>
      file.text.includes('shared/image/morphology'),
    );
    expect(users.length).toBeGreaterThan(0);
  });
});
