import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { randomUUID } from 'crypto';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  buildDirectorJsonSchema,
  buildDirectorJsonSchemaF1,
  buildDirectorJsonSchemaF2,
  buildDirectorJsonSchemaV2,
  buildDirectorSystemPrompt,
  buildDirectorSystemPromptF1,
  buildDirectorSystemPromptF2,
  buildDirectorSystemPromptV2,
  buildEndcard,
  buildMockScript,
  buildMockScriptF1,
  buildMockScriptF2,
  buildMockScriptV2,
  buildOfferCarouselScript,
  buildProductsSnapshot,
  buildScriptSeal,
  buildTalkingArtScript,
  DirectorF1Context,
  DirectorF2Context,
  normalizeDirectorScenes,
  normalizeDirectorScenesV2,
  RawDirectorF1,
  RawDirectorF2,
  RawDirectorScene,
  RawDirectorSceneV2,
} from '../domain/mc-director';
import { compositionDimensions } from '../domain/mc-composition.config';
import { talkEngineFor } from '../domain/mc-pipeline.config';
import { isPipelineV2, MC_SCRIPT_SCHEMA_V2 } from '../domain/mc-quality';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import {
  assertProjectTransition,
  assertStepTransition,
  McProjectStatus,
  McStepStatus,
} from '../domain/mc-state-machines';
import {
  isCarouselLayoutPreset,
  MC_DEFAULT_CAROUSEL_LAYOUT_PRESET,
  MC_OFFER_CAROUSEL_MAX_OFFERS,
  MC_TALKING_ART_MAX_OFFERS,
  McScript,
  McSealProduct,
  McStepType,
  resolveProjectOptions,
} from '../domain/mc-types';
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
    const v2 = isPipelineV2(project);
    // F1 "arte que fala" (change video-formatos-personagem, D6): diretor
    // próprio — narração + ofertas citadas, dividida em falas `talk_tile`.
    if (project.format === 'talking_art') {
      const ctx = await this.talkingArtContext(project, options.products, storeName);
      if (provider === 'mock') return buildMockScriptF1(ctx, () => randomUUID());
      if (provider === 'openai') return this.generateScriptOpenAiF1(project, ctx);
      throw new Error(`not_implemented: MC_SCRIPT_PROVIDER desconhecido '${provider}'`);
    }
    // F2 "ofertas em sequência" (tarefa 6.6): abertura + uma fala por oferta
    // congelada (na ordem) + fechamento, cada uma uma cena `talk_tile`.
    if (project.format === 'offer_carousel') {
      const ctx = await this.offerCarouselContext(project, options.products, storeName);
      if (provider === 'mock') return buildMockScriptF2(ctx, () => randomUUID());
      if (provider === 'openai') return this.generateScriptOpenAiF2(project, ctx);
      throw new Error(`not_implemented: MC_SCRIPT_PROVIDER desconhecido '${provider}'`);
    }
    if (provider === 'mock') {
      // Roteiro MOCK multi-cena — atravessa o pipeline inteiro sem chamar LLM
      // nem gastar um centavo. Legado: 2 faladas + 1 muda; v2: presenter +
      // action_voiceover + action (os três grafos do ADR).
      return v2
        ? buildMockScriptV2({ products: options.products, storeName }, () => randomUUID())
        : buildMockScript({ products: options.products, storeName });
    }
    if (provider === 'openai') {
      return v2
        ? this.generateScriptOpenAiV2(project, options.products, storeName)
        : this.generateScriptOpenAi(project, options.products, storeName);
    }
    throw new Error(`not_implemented: MC_SCRIPT_PROVIDER desconhecido '${provider}'`);
  }

  /**
   * Contexto do diretor F1: snapshot das ofertas (chave estável desde a
   * criação), limite do motor por fala (tier × identidade do kit), quadro de
   * saída (`compositionDimensions`) e dimensões do tile do kit (aspecto da
   * janela, D6); modo rosto do logo quando o kit é `logo_as_is` e a ponte
   * trouxe a caixa do logo (D9b).
   */
  private async talkingArtContext(
    project: McProject,
    optionProducts: McSealProduct[],
    storeName: string | null,
  ): Promise<DirectorF1Context> {
    const kit = await this.dataSource
      .getRepository(McCharacterKit)
      .findOneBy({ id: project.kitId });
    const tile = kit?.tileAssetId
      ? await this.dataSource.getRepository(AnimationAsset).findOneBy({ id: kit.tileAssetId })
      : null;
    const art = project.backgroundArtAssetId
      ? await this.dataSource
          .getRepository(AnimationAsset)
          .findOneBy({ id: project.backgroundArtAssetId })
      : null;
    const engine = talkEngineFor({
      tier: project.tier ?? 'economico',
      identityMode: kit?.identityMode ?? 'generated',
    });
    const frame = compositionDimensions(project.aspectRatio);
    return {
      products: buildProductsSnapshot(
        optionProducts,
        () => randomUUID(),
        MC_TALKING_ART_MAX_OFFERS,
      ),
      storeName,
      maxChunkS: engine.maxChunkS,
      frame: { width: frame.width, height: frame.height },
      tile: { width: tile?.width ?? null, height: tile?.height ?? null },
      art: art ? { width: art.width ?? null, height: art.height ?? null } : null,
      logoFace: kit?.identityMode === 'logo_as_is' && !!project.logoBox,
      logoBox: project.logoBox ?? null,
    };
  }

  /**
   * Contexto do diretor F2: ofertas congeladas na criação (ids estáveis, na
   * ORDEM escolhida, com preço anterior/unidade/badge/foto/catálogo), limite
   * do motor por fala (tier × identidade do kit), preset de layout do projeto
   * (default `character_left`) e legendas (opção do projeto).
   */
  private async offerCarouselContext(
    project: McProject,
    optionProducts: McSealProduct[],
    storeName: string | null,
  ): Promise<DirectorF2Context> {
    const kit = await this.dataSource
      .getRepository(McCharacterKit)
      .findOneBy({ id: project.kitId });
    const engine = talkEngineFor({
      tier: project.tier ?? 'economico',
      identityMode: kit?.identityMode ?? 'generated',
    });
    const options = resolveProjectOptions(project.options);
    return {
      offers: buildProductsSnapshot(
        optionProducts,
        () => randomUUID(),
        MC_OFFER_CAROUSEL_MAX_OFFERS,
      ),
      storeName,
      maxChunkS: engine.maxChunkS,
      layoutPreset: isCarouselLayoutPreset(project.layoutPreset)
        ? project.layoutPreset
        : MC_DEFAULT_CAROUSEL_LAYOUT_PRESET,
      captions: options.captionsEnabled,
    };
  }

  /**
   * Diretor F2 real: UMA chamada com json_schema estrito (abertura, exatamente
   * uma fala por oferta, fechamento). Nome e preço por extenso são conferidos
   * por oferta (fala que não cita vira a fala determinística) e o orçamento de
   * 30 s estimados é aplicado em `buildOfferCarouselScript`.
   */
  private async generateScriptOpenAiF2(
    project: McProject,
    ctx: DirectorF2Context,
  ): Promise<McScript> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('script_failed: OPENAI_API_KEY ausente');
    const model = process.env.MC_DIRECTOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: {
          type: 'json_schema',
          json_schema: buildDirectorJsonSchemaF2(ctx.offers.length),
        },
        messages: [
          {
            role: 'system',
            content: buildDirectorSystemPromptF2({
              offers: ctx.offers,
              storeName: ctx.storeName,
              maxChunkS: ctx.maxChunkS,
            }),
          },
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
    const parsed = JSON.parse(content) as RawDirectorF2;
    return buildOfferCarouselScript(parsed, ctx, () => randomUUID());
  }

  /**
   * Diretor F1 real: UMA chamada com json_schema estrito (narração + índices
   * das ofertas citadas); a divisão em falas, a janela e o modo rosto do logo
   * são determinísticos (`buildTalkingArtScript`). O briefing do usuário
   * entra como contexto adicional da arte.
   */
  private async generateScriptOpenAiF1(
    project: McProject,
    ctx: DirectorF1Context,
  ): Promise<McScript> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('script_failed: OPENAI_API_KEY ausente');
    const model = process.env.MC_DIRECTOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: 'json_schema', json_schema: buildDirectorJsonSchemaF1() },
        messages: [
          {
            role: 'system',
            content: buildDirectorSystemPromptF1({
              products: ctx.products,
              storeName: ctx.storeName,
              maxChunkS: ctx.maxChunkS,
            }),
          },
          { role: 'user', content: `Briefing da arte: ${project.briefing}` },
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
    const parsed = JSON.parse(content) as RawDirectorF1;
    return buildTalkingArtScript(parsed, ctx, () => randomUUID());
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
  /**
   * Diretor V2 (ADR-001 §3.1/§3.2): tipo de cena explícito, estado inicial
   * separado do movimento, produto por cena e derivação EN no próprio roteiro.
   */
  private async generateScriptOpenAiV2(
    project: McProject,
    optionProducts: McSealProduct[],
    storeName: string | null,
  ): Promise<McScript> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('script_failed: OPENAI_API_KEY ausente');
    const model = process.env.MC_DIRECTOR_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o';
    const targetDurationS = Math.min(60, Math.max(8, project.targetDurationS || 10));
    const products = buildProductsSnapshot(optionProducts, () => randomUUID());
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: 'json_schema', json_schema: buildDirectorJsonSchemaV2() },
        messages: [
          { role: 'system', content: buildDirectorSystemPromptV2({ targetDurationS, products }) },
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
    const parsed = JSON.parse(content) as { scenes?: RawDirectorSceneV2[] };
    const scenes = normalizeDirectorScenesV2(
      parsed.scenes ?? [],
      products,
      () => randomUUID(),
      `director:${model}`,
    );
    const endcard = buildEndcard(storeName);
    return {
      version: 1,
      schemaVersion: MC_SCRIPT_SCHEMA_V2,
      products,
      environments: [],
      scenes,
      seal: null,
      endcard: endcard ?? null,
    };
  }

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
