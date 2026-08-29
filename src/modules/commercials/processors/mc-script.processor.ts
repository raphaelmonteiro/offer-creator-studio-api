import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import {
  buildDirectorJsonSchema,
  buildDirectorSystemPrompt,
  buildEndcard,
  buildMockScript,
  buildScriptSeal,
  normalizeDirectorScenes,
  RawDirectorScene,
} from '../domain/mc-director';
import {
  assertProjectTransition,
  assertStepTransition,
  McProjectStatus,
  McStepStatus,
} from '../domain/mc-state-machines';
import { McScript, McSealProduct, McStepType, resolveProjectOptions } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';

/**
 * Consumer da fila mc.llm (Fase 0) — registrado apenas no worker
 * (WORKER_ONLY=true e MC_ENABLED=true, ver CommercialsModule.onModuleInit).
 *
 * MC_SCRIPT_PROVIDER=mock (default em dev): roteiro fixo MULTI-CENA (3 cenas,
 * 2 faladas + 1 muda) SEM chamar LLM — é o que permite o e2e fila → steps →
 * evento → SSE de custo zero, já exercitando o motor de ação da cena muda.
 * MC_SCRIPT_PROVIDER=openai: diretor real multi-cena (json_schema estrito do
 * McScript v2; 1..8 cenas conforme a duração alvo — domain/mc-director.ts).
 *
 * Toda transição é CAS: job duplicado/expirado que re-entra encontra o step
 * fora de 'queued' e vira no-op.
 */
@Injectable()
export class McScriptProcessor {
  private readonly logger = new Logger(McScriptProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly credits: CreditsService,
  ) {}

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    if (!step || step.type !== McStepType.SCRIPT) return;

    assertStepTransition(McStepStatus.QUEUED, McStepStatus.RUNNING);
    const won = await this.dataSource.transaction((m) =>
      this.transitions.casTransition(m, McStep, stepId, McStepStatus.QUEUED, McStepStatus.RUNNING, {
        startedAt: new Date(),
        attempts: step.attempts + 1,
      }),
    );
    if (!won) return; // outro worker venceu, ou o step já saiu de queued

    const project = await this.dataSource.getRepository(McProject).findOneBy({
      id: step.projectId,
    });
    if (!project) return;

    try {
      const script = await this.generateScript(project);
      await this.dataSource.transaction(async (manager) => {
        assertStepTransition(McStepStatus.RUNNING, McStepStatus.SUCCEEDED);
        await this.transitions.casTransition(
          manager,
          McStep,
          stepId,
          McStepStatus.RUNNING,
          McStepStatus.SUCCEEDED,
          { finishedAt: new Date(), provider: this.provider() },
        );
        await this.commercials.appendEvent(manager, {
          userId: project.userId,
          refKind: 'step',
          refId: stepId,
          kind: 'transition',
          fromStatus: McStepStatus.RUNNING,
          toStatus: McStepStatus.SUCCEEDED,
          detail: { type: McStepType.SCRIPT, provider: this.provider() },
        });

        // roteiro gravado no projeto (fonte de verdade) + GATE humano
        await manager.update(McProject, { id: project.id }, { script });
        assertProjectTransition(McProjectStatus.SCRIPTING, McProjectStatus.STORYBOARD_REVIEW);
        const wonProject = await this.transitions.casTransition(
          manager,
          McProject,
          project.id,
          McProjectStatus.SCRIPTING,
          McProjectStatus.STORYBOARD_REVIEW,
        );
        if (wonProject) {
          await this.commercials.appendEvent(manager, {
            userId: project.userId,
            refKind: 'project',
            refId: project.id,
            kind: 'transition',
            fromStatus: McProjectStatus.SCRIPTING,
            toStatus: McProjectStatus.STORYBOARD_REVIEW,
            detail: { sceneCount: script.scenes.length },
          });
          await this.transitions.notify(
            manager,
            project.userId,
            {
              kind: 'mc_project',
              projectId: project.id,
              status: McProjectStatus.STORYBOARD_REVIEW,
            },
            MC_EVENTS_CHANNEL,
          );
        }
      });
    } catch (err) {
      const message = (err as Error).message ?? 'erro desconhecido';
      const code = message.startsWith('not_implemented') ? 'not_implemented' : 'script_failed';
      this.logger.error(`Step ${stepId} falhou: ${message}`);
      await this.dataSource.transaction(async (manager) => {
        await this.transitions.casTransition(
          manager,
          McStep,
          stepId,
          McStepStatus.RUNNING,
          McStepStatus.FAILED,
          {
            finishedAt: new Date(),
            errorClass: 'internal',
            errorCode: code,
            errorMessage: message,
          },
        );
        const wonProject = await this.transitions.casTransition(
          manager,
          McProject,
          project.id,
          McProjectStatus.SCRIPTING,
          McProjectStatus.FAILED,
          { errorCode: code, errorMessage: message, finishedAt: new Date() },
        );
        if (wonProject) {
          // Falha terminal do script = projeto falhou inteiro → estorno TOTAL
          // da mini-reserva da criação (plano §6.7). Idempotente por
          // construção (refundUnconsumed vira no-op se já houve estorno) e só
          // quem VENCE o CAS estorna — job duplicado não estorna duas vezes.
          // Com cobrança desligada reservedCredits=0 e o estorno é no-op.
          await this.credits.refundUnconsumed(
            manager,
            project.userId,
            project.id,
            project.reservedCredits,
            project.consumedCredits,
          );
          await this.commercials.appendEvent(manager, {
            userId: project.userId,
            refKind: 'project',
            refId: project.id,
            kind: 'transition',
            fromStatus: McProjectStatus.SCRIPTING,
            toStatus: McProjectStatus.FAILED,
            detail: { errorCode: code, stepId },
          });
          await this.transitions.notify(
            manager,
            project.userId,
            {
              kind: 'mc_project',
              projectId: project.id,
              status: McProjectStatus.FAILED,
            },
            MC_EVENTS_CHANNEL,
          );
        }
      });
      // Não relança de propósito: o failed já foi registrado com CAS e o
      // not_implemented é permanente — retry do pg-boss só faria barulho.
      // A política de retry por CLASSE de erro (transient 3×, §6.4) entra
      // junto com os providers reais.
    }
  }

  private provider(): string {
    return process.env.MC_SCRIPT_PROVIDER || 'mock';
  }

  /** Briefing/duração/produtos do projeto viram o input do diretor (LLM) no provider real. */
  private async generateScript(project: McProject): Promise<McScript> {
    const provider = this.provider();
    const options = resolveProjectOptions(project.options);
    const storeName = await this.storeNameOf(project.userId);
    if (provider === 'mock') {
      // Roteiro MOCK multi-cena (3 cenas: 2 faladas + 1 muda) — atravessa o
      // pipeline inteiro, incluindo o motor de ação da cena muda, sem chamar
      // LLM nem gastar um centavo (domain/mc-director.buildMockScript).
      return buildMockScript({ products: options.products, storeName });
    }
    if (provider === 'openai') {
      return this.generateScriptOpenAi(project, options.products, storeName);
    }
    throw new Error(`not_implemented: MC_SCRIPT_PROVIDER desconhecido '${provider}'`);
  }

  /**
   * Nome do estabelecimento do usuário (users.establishment.tradeName) — vira
   * a cartela final determinística do roteiro. Ausente/sem cadastro ⇒ sem
   * cartela (o campo `endcard` simplesmente não entra no roteiro).
   * Leitura por query crua: o commercials não acopla seu módulo ao auth por
   * causa de um nome de loja.
   */
  private async storeNameOf(userId: string): Promise<string | null> {
    try {
      const rows = (await this.dataSource.query(
        'SELECT "establishment" FROM "users" WHERE "id" = $1 LIMIT 1',
        [userId],
      )) as Array<{ establishment?: { tradeName?: string | null } | null }>;
      return rows?.[0]?.establishment?.tradeName?.trim() || null;
    } catch (err) {
      this.logger.warn(
        `Estabelecimento do usuário ${userId} indisponível: ${
          (err as Error).message
        } — roteiro segue sem cartela final.`,
      );
      return null;
    }
  }

  /**
   * Diretor real multi-cena (plano §5.1 etapa 1): briefing → 1..8 cenas via
   * chat completions com json_schema ESTRITO do McScript v2. Todas as regras
   * de produto (nº de cenas por duração, continuidade de cenário, preço por
   * extenso, 1 ação física por cena, nada de texto na cena, CTA na última) e
   * a normalização da resposta vivem em domain/mc-director.ts — puras e
   * testadas; aqui só acontece a chamada de rede.
   */
  private async generateScriptOpenAi(
    project: McProject,
    products: McSealProduct[],
    storeName: string | null,
  ): Promise<McScript> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('script_failed: OPENAI_API_KEY ausente');
    // Modelo FORTE de propósito (1 chamada por projeto, centavos): o diretor
    // precisa respeitar contagem de palavras por cena, continuidade de cenário
    // e preço por extenso ao mesmo tempo — o modelo rápido entregava falas
    // curtas demais e truncava o comercial (achado da 1ª produção real).
    const model = process.env.MC_DIRECTOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o';
    const targetDurationS = Math.min(60, Math.max(8, project.targetDurationS || 10));

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: 'json_schema', json_schema: buildDirectorJsonSchema() },
        messages: [
          { role: 'system', content: buildDirectorSystemPrompt({ targetDurationS, products }) },
          { role: 'user', content: `Briefing: ${project.briefing}` },
        ],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(`script_failed: OpenAI HTTP ${res.status}: ${body?.error?.message ?? ''}`);
    }
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('script_failed: resposta do OpenAI sem conteúdo');
    const parsed = JSON.parse(content) as { scenes?: RawDirectorScene[] };
    const scenes = normalizeDirectorScenes(parsed.scenes ?? []);
    const seal = buildScriptSeal(products);
    const endcard = buildEndcard(storeName);
    return {
      version: 2,
      scenes,
      ...(seal ? { seal } : {}),
      ...(endcard ? { endcard } : {}),
    };
  }
}
