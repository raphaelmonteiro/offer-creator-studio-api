import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from './mc-pipeline.service';
import { buildFailStepHarness, project, Row, talk } from './mc-pipeline.fail-step.fixture';

/** failStep grava o texto do catálogo (pt-BR) no projeto e na cena, nunca a mensagem crua do fornecedor (task 1.5). */
describe('McPipelineService.failStep — motivo gravado no projeto e na cena', () => {
  let projects: Row[];
  let steps: Row[];
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let service: McPipelineService;

  beforeEach(() => {
    ({ projects, steps, transitions, service } = buildFailStepHarness());
  });

  afterEach(() => jest.restoreAllMocks());

  const fail = (row: Row, err: unknown) =>
    service.failStep(row as unknown as McStep, McStepStatus.PROVIDER_WAIT, err);

  describe('motivo em pt-BR gravado no projeto e na cena (catálogo, sem a mensagem crua)', () => {
    const RAW = 'HTTP 403: {"detail":"User is locked. Reason: Exhausted balance"}';
    const P27 =
      'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.';
    const casPatch = (entity: unknown, to: string): Record<string, unknown> | undefined =>
      transitions.casTransition.mock.calls.find(
        (call) => call[1] === entity && call[4] === to,
      )?.[5];
    const stepPatch = () => casPatch(McStep, McStepStatus.FAILED);

    it('cena em produção com cota: projeto e cena com o texto de P-27; o step guarda a crua', async () => {
      steps.push(talk('t1', 'p1'));
      await fail(steps[0], new TerminalProviderError(RAW, 'quota'));
      expect(casPatch(McProject, McProjectStatus.NEEDS_ATTENTION)).toMatchObject({
        errorCode: 'quota',
        errorMessage: P27,
      });
      expect(casPatch(McScene, McSceneStatus.FAILED)).toEqual({
        errorCode: 'quota',
        errorMessage: P27,
      });
      expect(stepPatch()).toMatchObject({ errorCode: 'quota', errorMessage: RAW });
    });

    it('cena em preparação (v2, tts): o projeto também recebe errorMessage na fase de preparação', async () => {
      projects[0] = {
        ...project('p1', 'u1'),
        status: McProjectStatus.PREPARING,
        pipelineVersion: 2,
      };
      steps.push(talk('t1', 'p1', { type: McStepType.TTS, status: McStepStatus.RUNNING }));
      await service.failStep(
        steps[0] as unknown as McStep,
        McStepStatus.RUNNING,
        new TerminalProviderError(RAW, 'quota'),
      );
      expect(casPatch(McProject, McProjectStatus.NEEDS_ATTENTION)).toMatchObject({
        errorCode: 'quota',
        errorMessage: P27,
        quality: expect.objectContaining({ resumePhase: 'preparation' }),
      });
    });

    it.each([
      [
        'fora do ar esgotado',
        new TransientProviderError('HTTP 503'),
        'provider_transient',
        /fora do ar/,
      ],
      [
        'arquivo ausente',
        new TerminalProviderError('Áudio ausente no disco', 'missing_input_asset'),
        'missing_input_asset',
        /arquivo da gravação não foi encontrado/,
      ],
      [
        'código desconhecido',
        new Error('boom inglês'),
        'talk_failed',
        /Algo deu errado na produção do vídeo/,
      ],
    ])('%s', async (_name, err, code, text) => {
      steps.push(talk('t1', 'p1', { attempts: 4 }));
      await fail(steps[0], err);
      const patch = casPatch(McProject, McProjectStatus.NEEDS_ATTENTION);
      expect(patch).toMatchObject({ errorCode: code });
      expect(String(patch?.errorMessage)).toMatch(text);
      expect(String(patch?.errorMessage)).not.toMatch(/HTTP|boom|ausente no disco/);
    });

    it('montagem v2 (compose_ffmpeg): projeto em needs_attention com o texto do catálogo', async () => {
      projects[0] = {
        ...project('p1', 'u1'),
        status: McProjectStatus.ASSEMBLING,
        pipelineVersion: 2,
      };
      steps.push(
        talk('c1', 'p1', {
          type: McStepType.COMPOSE_FFMPEG,
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.RUNNING,
          providerJobId: null,
        }),
      );
      await service.failStep(
        steps[0] as unknown as McStep,
        McStepStatus.RUNNING,
        new TerminalProviderError('HTTP 400: x', 'provider_rejected'),
      );
      const patch = casPatch(McProject, McProjectStatus.NEEDS_ATTENTION);
      expect(patch).toMatchObject({ errorCode: 'provider_rejected' });
      expect(String(patch?.errorMessage)).toMatch(/não aceitou o pedido/);
    });

    it('ASSEMBLY legado: projeto failed com o texto do catálogo', async () => {
      projects[0] = { ...project('p1', 'u1'), status: McProjectStatus.ASSEMBLING };
      steps.push(
        talk('a1', 'p1', {
          type: McStepType.ASSEMBLY,
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.RUNNING,
          attempts: 2,
          providerJobId: null,
        }),
      );
      await service.failStep(
        steps[0] as unknown as McStep,
        McStepStatus.RUNNING,
        new Error('ffmpeg saiu com código 1'),
      );
      const patch = casPatch(McProject, McProjectStatus.FAILED);
      expect(patch).toMatchObject({ errorCode: 'assembly_failed' });
      expect(String(patch?.errorMessage)).toBe(
        'Algo deu errado na produção do vídeo. Tente refazer.',
      );
    });

    it('character_cutout_failed mantém o texto pt-BR do recorte (passthrough)', async () => {
      steps.push(talk('t1', 'p1', { providerJobId: null }));
      await fail(
        steps[0],
        new TerminalProviderError(
          'O recorte da personagem ficou com falhas em 2 fala(s).',
          'character_cutout_failed',
        ),
      );
      expect(casPatch(McProject, McProjectStatus.NEEDS_ATTENTION)).toMatchObject({
        errorMessage: 'O recorte da personagem ficou com falhas em 2 fala(s).',
      });
    });

    it('falha repetida (CAS perdido) não altera nada do projeto', async () => {
      steps.push(talk('t1', 'p1'));
      await fail(steps[0], new TerminalProviderError(RAW, 'quota'));
      transitions.casTransition.mockClear();
      await fail(steps[0], new TerminalProviderError(RAW, 'quota'));
      expect(casPatch(McProject, McProjectStatus.NEEDS_ATTENTION)).toBeUndefined();
    });
  });
});
