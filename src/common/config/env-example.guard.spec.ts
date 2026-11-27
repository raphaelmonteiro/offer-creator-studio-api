import * as fs from 'fs';
import * as path from 'path';
import {
  listSources,
  profileProblems,
  SourceFile,
  TEST_ONLY_VARS,
} from './env-example.guard.testutil';

/**
 * Trava do `backend/.env.example` (capability backend-env-profile, D-orq-193): o que o código lê e o que o exemplo traz
 * não se separam, e segredo nenhum vem com valor.
 */
const SRC = path.resolve(__dirname, '..', '..');
const EXAMPLE = path.resolve(SRC, '..', '.env.example');
const NO_PROBLEMS = { unlisted: [], unread: [], secretsWithValue: [] };

const reader = (rel: string, text: string): SourceFile => ({ rel, text });

describe('guarda do .env.example contra o código', () => {
  it('toda variável de IA e de função que o código lê tem linha, nenhuma linha fica sem leitor e nenhum segredo tem valor', () => {
    const problems = profileProblems(listSources(SRC), fs.readFileSync(EXAMPLE, 'utf8'));
    expect(problems).toEqual(NO_PROBLEMS);
  });

  describe('as regras acusam o que a revisão pegava', () => {
    it('Variável nova sem linha: reprova e cita a variável e o arquivo que a lê', () => {
      const files = [reader('modules/ai/foo.service.ts', "this.config.get('AI_FOO_ENABLED')")];

      const problems = profileProblems(files, 'MC_ENABLED=true\n');

      expect(problems.unlisted).toEqual(['AI_FOO_ENABLED (lida em modules/ai/foo.service.ts)']);
    });

    it('lê também por env.X, process.env.X e pelo sufixo do arquivo com PREFIX', () => {
      const files = [
        reader(
          'a.ts',
          'const on = env.MC_NEW_FLAG === "true"; const p = process.env.AI_OTHER_FLAG;',
        ),
        reader('b.ts', "const PREFIX = 'FLYER_PRO_NEW_';\nrawEnv(config, PREFIX + 'LIMIT');"),
      ];

      const names = profileProblems(files, '').unlisted.map((line) => line.split(' ')[0]);

      expect(names.sort()).toEqual(['AI_OTHER_FLAG', 'FLYER_PRO_NEW_LIMIT', 'MC_NEW_FLAG']);
    });

    it('Linha sem leitor: reprova e cita a linha (a variável só citada no aviso de "sem efeito" não conta como leitor)', () => {
      const warnOnly = reader(
        'modules/ai/openai-retiring-models.service.ts',
        "const DALLE_VARS = ['OPENAI_ENABLE_DALLE_FALLBACK', 'OPENAI_DALLE_FALLBACK_MODEL'];",
      );

      const problems = profileProblems(
        [warnOnly],
        'OPENAI_ENABLE_DALLE_FALLBACK=false\nOPENAI_DALLE_FALLBACK_MODEL=dall-e-3\n',
      );

      expect(problems.unread).toEqual([
        'OPENAI_ENABLE_DALLE_FALLBACK (linha 1)',
        'OPENAI_DALLE_FALLBACK_MODEL (linha 2)',
      ]);
      expect(profileProblems([warnOnly], '').unlisted).toEqual([]);
    });

    it('Linha comentada com o valor vale como linha e como linha com leitor', () => {
      const files = [reader('a.ts', "config.get('OPENAI_TEXT_MODEL')")];

      expect(profileProblems(files, '# OPENAI_TEXT_MODEL=gpt-6-luna\n')).toEqual(NO_PROBLEMS);
    });

    it('Variável só de teste: passa sem linha, porque está na lista', () => {
      const files = [
        reader(
          'modules/template-scenes/testing/scene-test-db.ts',
          'process.env.TEMPLATE_SCENE_E2E_DB_URL',
        ),
      ];

      expect(TEST_ONLY_VARS).toHaveProperty('TEMPLATE_SCENE_E2E_DB_URL');
      expect(profileProblems(files, '').unlisted).toEqual([]);
    });

    it('Prefixo dinâmico: as linhas OPENAI_COST_* e MC_TALK_ENGINE_* cobrem os nomes montados e os literais com o prefixo', () => {
      const files = [
        reader('a.ts', "readEnvNumber(`OPENAI_COST_IMAGE_${mode}_USD`, 'OPENAI_COST_IMAGE_USD')"),
        reader('b.ts', "const ENV = { premium: 'MC_TALK_ENGINE_PREMIUM' };"),
      ];
      const example = 'OPENAI_COST_IMAGE_FINAL_USD=\nMC_TALK_ENGINE_ECONOMICO=a|1|2\n';

      expect(profileProblems(files, example)).toEqual(NO_PROBLEMS);
      expect(profileProblems(files, '').unlisted).toHaveLength(2);
    });

    it('Chave com valor: reprova e cita a linha, ativa ou comentada; vazia passa', () => {
      const files = [reader('a.ts', "config.get('OPENAI_API_KEY'); config.get('ADMIN_API_TOKEN')")];

      const problems = profileProblems(files, 'OPENAI_API_KEY=sk-...\n# ADMIN_API_TOKEN=abc\n');

      expect(problems.secretsWithValue).toEqual([
        'OPENAI_API_KEY (linha 1)',
        'ADMIN_API_TOKEN (linha 2)',
      ]);
      expect(
        profileProblems(files, 'OPENAI_API_KEY=\nADMIN_API_TOKEN=\n').secretsWithValue,
      ).toEqual([]);
    });

    it('não confunde com leitura: código de erro, token de injeção, comentário e arquivo de erros', () => {
      const files = [
        reader(
          'a.ts',
          "throw { code: 'MC_PAUSED' }; export const FLYER_PRO_ENRICH_PORT = 'FLYER_PRO_ENRICH_PORT';",
        ),
        reader(
          'b.ts',
          "// lê AI_COMMENTED_ONLY\n/* process.env.AI_BLOCK_COMMENT */ type T = Extract<E, 'AI_PROVIDER_ERROR' | 'AI_TIMEOUT'>;\ntype U =\n  | 'AI_TIMEOUT'",
        ),
        reader('c.errors.ts', "export const e = 'FLYER_PRO_NOT_FOUND';"),
      ];

      expect(profileProblems(files, '').unlisted).toEqual([]);
    });
  });
});
