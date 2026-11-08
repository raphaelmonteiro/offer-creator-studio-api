import { Injectable, Logger } from '@nestjs/common';
import { SceneDirectorContextService } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { DirectorRunResult, runDirector } from './scene-director-run';
import { SceneDirectorState } from './scene-director-state';

export interface SceneDirectorJob {
  sceneId: string;
  versionId: string;
}

/**
 * Consumer de `template_scene.director`: lê a mensagem com o Diretor. Regras:
 * - job repetido (versão fora de `queued` + `reading`) sai sem chamar o Diretor nem a imagem;
 * - o lock só é tomado ao começar e ao terminar, nunca durante a chamada ao Diretor;
 * - o Diretor roda numa fila própria, fora da vaga da chamada de imagem, e nunca ocupa a fila de outra cena;
 * - nunca lança depois de uma chamada paga: qualquer erro vira falha da versão, e a fila não repete (a chamada é paga).
 */
@Injectable()
export class SceneDirectorProcessor {
  private readonly logger = new Logger(SceneDirectorProcessor.name);

  constructor(
    private readonly state: SceneDirectorState,
    private readonly contexts: SceneDirectorContextService,
    private readonly director: SceneDirectorService,
  ) {}

  async process(job: SceneDirectorJob, jobId?: string): Promise<void> {
    let result: DirectorRunResult | undefined;
    try {
      const turn = await this.state.begin(job.sceneId, job.versionId);
      if (!turn) {
        this.logger.log(
          `Job ${jobId ?? '?'} do Diretor ignorado: versão ${job.versionId} não está lendo`,
        );
        return;
      }
      const context = await this.contexts.build(turn.scene, turn.version);
      result = await runDirector(this.director, {
        context,
        correlationId: turn.version.correlationId,
      });
      await this.state.settle(turn, context, result);
    } catch (error) {
      this.logger.error(
        `Leitura da cena ${job.sceneId} falhou (versão ${job.versionId}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      await this.state
        // O Diretor já pode ter sido cobrado: o custo das chamadas vai junto, fora do rollback de `settle` (R13).
        .failReading(job.sceneId, job.versionId, 'DIRECTOR_UNAVAILABLE', result?.calls)
        .catch((failure: Error) =>
          this.logger.error(
            `Não foi possível fechar a leitura ${job.versionId}: ${failure.message}`,
          ),
        );
    }
  }
}
