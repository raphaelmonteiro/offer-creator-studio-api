import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Not, IsNull } from 'typeorm';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  GEMINI_IMAGE_MODEL,
  geminiBilledFailure,
  GeminiImageProvider,
  GeminiUsage,
} from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { KIT_TILE_BACKGROUND_DEFAULT } from '../domain/kit-prompts';
import {
  geminiUsage,
  kitFailedCallCost,
  kitProviderCost,
  McKitProviderCost,
} from '../domain/mc-kit-costs';
import { decideMouthGate } from '../domain/mc-mouth-gate';
import { assertKitTransition, McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitCandidate } from '../entities/mc-kit-candidate.entity';
import { listStyleReferences } from '../services/mc-kit-candidates.service';
import { costMetadata, recordKitProviderCost } from '../services/mc-kit-costs';
import { McKitViewService } from '../services/mc-kit-view.service';
import { McStorageService } from '../services/mc-storage.service';
import { mockCharacterImage } from './mc-kit-mock-image';

const MOCK_CANDIDATE_COLORS = ['#4F86C6', '#6BAA75', '#C68C4F', '#A05FB5', '#D9534F', '#2A9D8F'];

/**
 * Consumer da fila mc.image para RODADAS de candidatos (D4), despachado pelo
 * módulo quando o payload traz `candidates: true` ({kitId, roundId}).
 *
 * `mascotization`: Nano Banana Pro `edit` com o logo como primeira referência
 * (+ até 3 referências de estilo), um candidato por linha pré-inserida; ao
 * fim, kit generating → candidates. Falha de UM candidato registra evento e
 * segue; rodada sem nenhum candidato cai para a rodada anterior (ou para
 * `candidates` vazio quando "usar como está" existe) e, sem alternativa,
 * para failed.
 *
 * `mouth_variant`: a mesma chamada sobre a identidade atual; o kit fica em
 * review e a UI é avisada por evento (`mouth_variant_ready`).
 *
 * MC_KIT_PROVIDER=mock: PNGs sintéticos (fundo liso + cabeça na caixa do
 * gate mock) — a rodada inteira sem gastar API.
 *
 * Idempotência por rodada (M2): o job só vale enquanto `kit.candidateRoundId`
 * for a sua rodada (a escolha de um candidato ou "usar como está" fecham a
 * rodada e o job atrasado/duplicado vira no-op); as transições terminais
 * repetem a cerca na MESMA UPDATE do CAS. Execuções sobrepostas da mesma
 * rodada no mesmo worker (retry do pg-boss após expiração com a primeira
 * ainda rodando) esperam a execução em curso (claim em memória com a
 * promessa: o job conclui ou falha junto com ela); entre processos, a
 * gravação do asset na linha é um CAS (`assetId IS NULL`) e o perdedor
 * descarta a imagem — nunca dois assets para a mesma linha.
 *
 * CUSTO (tarefa 2.6): cada candidato/variante gerado de verdade grava o custo
 * no metadata do asset e, na MESMA transação, um evento `provider_cost` e a
 * soma em `mc_character_kits.providerCostUsd` — inclusive o asset descartado
 * pelo CAS (a imagem foi paga). Resposta 200 sem imagem e timeout (terminal,
 * `retryOnTimeout: false`: a requisição abortada pode ter sido cobrada) viram
 * linha de custo sem asset (o timeout, estimado).
 */
@Injectable()
export class McKitCandidatesProcessor {
  private readonly logger = new Logger(McKitCandidatesProcessor.name);
  /** Execuções em curso neste processo (`kitId:roundId`). */
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly gemini: GeminiImageProvider,
    private readonly mascots: MascotsService,
    private readonly storage: McStorageService,
    private readonly view: McKitViewService,
  ) {}

  async process({ kitId, roundId }: { kitId: string; roundId: string }): Promise<void> {
    const claim = `${kitId}:${roundId}`;
    const running = this.active.get(claim);
    if (running) {
      // a re-entrega espera a execução em curso: o job conclui (ou falha e
      // volta a ser re-tentado) junto com o trabalho real, nunca antes dele
      this.logger.warn(
        `Kit ${kitId}: rodada ${roundId} já em execução neste worker — aguardando a execução em curso.`,
      );
      return running;
    }
    const execution = this.run(kitId, roundId).finally(() => this.active.delete(claim));
    this.active.set(claim, execution);
    return execution;
  }

  private async run(kitId: string, roundId: string): Promise<void> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    if (!kit) return;
    // Cerca de rodada: a escolha/"usar como está" fecha a rodada corrente
    // (candidateRoundId nulo ou de outra rodada) — job atrasado é no-op.
    if (kit.candidateRoundId !== roundId) {
      this.logger.warn(
        `Kit ${kitId}: job da rodada ${roundId} chegou com a rodada corrente ` +
          `${kit.candidateRoundId ?? 'nenhuma'} — ignorado.`,
      );
      return;
    }
    const rows = await this.dataSource
      .getRepository(McKitCandidate)
      .find({ where: { kitId, roundId }, order: { idx: 'ASC' } });
    if (rows.length === 0) return;
    const kind = rows[0].kind ?? 'mascotization';
    // Idempotência: job duplicado/expirado com o kit já fora do estado esperado é no-op.
    const expected = kind === 'mouth_variant' ? McKitStatus.REVIEW : McKitStatus.GENERATING;
    if (kit.status !== expected) return;

    let source: Buffer;
    try {
      source = kind === 'mouth_variant' ? await this.loadIdentity(kit) : await this.loadLogo(kit);
    } catch (err) {
      await this.roundFailed(kit, kind, roundId, (err as Error).message);
      return;
    }
    const styleRefs = kind === 'mascotization' ? await this.loadStyleReferences(kit) : [];

    let ready = 0;
    let attempted = 0;
    for (const row of rows) {
      if (row.assetId) {
        ready += 1;
        continue;
      }
      // A cerca vale a cada imagem, não só na entrada: "usar como está" ou a
      // escolha de um candidato fecham a rodada no meio — parar aqui poupa as
      // chamadas restantes (o CAS terminal já viraria no-op).
      if (attempted++ > 0 && !(await this.roundStillOpen(kit.id, roundId, expected))) {
        this.logger.warn(
          `Kit ${kit.id}: rodada ${roundId} fechada durante a geração — interrompida.`,
        );
        return;
      }
      try {
        const assetId = await this.generateCandidate(kit, row, source, styleRefs);
        // CAS na linha: outra execução (outro processo) pode ter preenchido
        // antes — o asset perdedor é descartado, a linha nunca troca de imagem.
        const result = await this.dataSource
          .getRepository(McKitCandidate)
          .update({ id: row.id, assetId: IsNull() }, { assetId });
        if (result?.affected === 0) {
          this.logger.warn(
            `Kit ${kit.id}: candidato ${row.idx} da rodada ${roundId} já preenchido por outra execução — imagem descartada.`,
          );
          await this.dataSource.getRepository(AnimationAsset).softDelete(assetId);
        }
        ready += 1;
      } catch (err) {
        const message = (err as Error).message ?? 'erro desconhecido';
        this.logger.warn(
          `Kit ${kit.id}: candidato ${row.idx} da rodada ${roundId} falhou: ${message}`,
        );
        await this.dataSource.transaction((m) =>
          this.commercials.appendEvent(m, {
            userId: kit.userId,
            refKind: 'kit',
            refId: kit.id,
            kind: 'candidate_failed',
            detail: { roundId, idx: row.idx, candidateKind: kind, error: message.slice(0, 300) },
          }),
        );
      }
    }

    if (kind === 'mouth_variant') {
      await this.finishMouthVariant(kit, roundId, ready);
      return;
    }
    if (ready === 0) {
      await this.roundFailed(kit, kind, roundId, 'Nenhum candidato foi gerado nesta rodada');
      return;
    }
    assertKitTransition(McKitStatus.GENERATING, McKitStatus.CANDIDATES);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.GENERATING,
        McKitStatus.CANDIDATES,
        { candidateRoundId: roundId },
        this.sameRound(roundId),
      );
      if (!won) return;
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.GENERATING,
        toStatus: McKitStatus.CANDIDATES,
        detail: { roundId, ready, requested: rows.length },
      });
      await this.notify(manager, kit, McKitStatus.CANDIDATES, 'candidates_ready');
    });
  }

  // ─────────────────────────────── geração ───────────────────────────────

  private provider(): string {
    return process.env.MC_KIT_PROVIDER || 'mock';
  }

  private async generateCandidate(
    kit: McCharacterKit,
    row: McKitCandidate,
    source: Buffer,
    styleRefs: Buffer[],
  ): Promise<string> {
    const background = kit.tileBackgroundColor ?? KIT_TILE_BACKGROUND_DEFAULT;
    const call = row.kind === 'mouth_variant' ? 'mouth_variant' : 'candidate';
    const costContext = { roundId: row.roundId, candidateId: row.id, idx: row.idx };
    let generated: { image: Buffer; model: string; usage?: GeminiUsage | null };
    if (this.provider() === 'mock') {
      generated = {
        image: await mockCharacterImage({
          background: /^#/.test(background) ? background : KIT_TILE_BACKGROUND_DEFAULT,
          color: MOCK_CANDIDATE_COLORS[row.idx % MOCK_CANDIDATE_COLORS.length],
          label: `${row.kind} ${row.idx + 1} — mock`,
        }),
        model: 'mock',
        usage: null,
      };
    } else {
      try {
        generated = await this.gemini.generateImageWithModel({
          prompt: row.prompt,
          referenceImages: [source, ...styleRefs],
          aspectRatio: '3:4',
          model: GEMINI_IMAGE_MODEL,
          retryOnTimeout: false,
        });
      } catch (err) {
        await this.recordFailedCallCost(kit, call, err, costContext);
        throw err;
      }
    }
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          prompt: row.prompt,
          source: createHash('sha256').update(source).digest('hex'),
          styleRefs: styleRefs.length,
          model: generated.model,
          idx: row.idx,
        }),
      )
      .digest('hex');
    const cost: McKitProviderCost | null =
      this.provider() === 'mock'
        ? null
        : kitProviderCost({
            call,
            provider: 'gemini',
            model: generated.model,
            usage: geminiUsage(generated.usage, 1),
          });
    let url: string;
    try {
      url = await this.storage.saveFile(
        `commercials/kits/${kit.id}`,
        `candidate-${row.roundId.slice(0, 8)}-${row.idx}-${Date.now()}.png`,
        generated.image,
      );
    } catch (err) {
      // a imagem foi paga mesmo sem asset: o custo fica registrado
      if (cost) {
        await this.dataSource.transaction((manager) =>
          recordKitProviderCost(manager, this.commercials, kit, cost, {
            ...costContext,
            assetId: null,
          }),
        );
      }
      throw err;
    }
    return this.dataSource.transaction(async (manager) => {
      const asset = await manager.save(AnimationAsset, {
        userId: kit.userId,
        kind: 'kit_candidate' as const,
        status: 'ready' as const,
        name: `${row.kind === 'mouth_variant' ? 'Variante com boca' : 'Candidato'} ${row.idx + 1} — ${kit.id.slice(0, 8)}`,
        origin: 'ai_generated' as const,
        fileUrl: url,
        mimeType: 'image/png',
        fileSize: String(generated.image.length),
        contentHash: inputHash,
        metadata: {
          kitId: kit.id,
          roundId: row.roundId,
          candidateId: row.id,
          idx: row.idx,
          candidateKind: row.kind,
          provider: this.provider(),
          model: generated.model,
          style: kit.style,
          source: kit.source,
          styleReferences: styleRefs.length,
          prompt: row.prompt.slice(0, 1500),
          ...costMetadata(cost),
        },
      });
      if (cost) {
        await recordKitProviderCost(manager, this.commercials, kit, cost, {
          ...costContext,
          assetId: asset.id,
        });
      }
      return asset.id;
    });
  }

  /**
   * Chamada que falhou DEPOIS de cobrada (200 sem imagem, timeout): linha de
   * custo sem asset antes de o erro seguir; falha no registro só loga.
   */
  private async recordFailedCallCost(
    kit: McCharacterKit,
    call: 'candidate' | 'mouth_variant',
    err: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    const billing = geminiBilledFailure(err);
    if (!billing) return;
    const cost = kitFailedCallCost({ call, billing, expectedImages: 1 });
    try {
      await this.dataSource.transaction((manager) =>
        recordKitProviderCost(manager, this.commercials, kit, cost, {
          ...context,
          assetId: null,
          ...(err instanceof TerminalProviderError ? { providerErrorCode: err.code } : {}),
        }),
      );
    } catch (recordErr) {
      this.logger.error(
        `Kit ${kit.id}: custo da chamada ${call} sem resultado não registrado: ${(recordErr as Error).message}`,
      );
    }
  }

  // ─────────────────────────────── insumos ───────────────────────────────

  /** Logo registrado como personagem de origem (recorte com alfa, senão a fonte). */
  private async loadLogo(kit: McCharacterKit): Promise<Buffer> {
    const mascot = await this.mascots.findOne(kit.userId, kit.mascotId);
    const imageUrl = mascot.cutoutUrl ?? mascot.sourceImageUrl;
    if (!imageUrl) throw new Error('Logo sem imagem utilizável (recorte ou fonte)');
    const buffer = await this.storage.readUploadsFile(imageUrl);
    if (!buffer) throw new Error('Arquivo de imagem do logo não encontrado no disco');
    return buffer;
  }

  /** Identidade atual (candidato escolhido / referência frontal), senão a imagem do mascote. */
  private async loadIdentity(kit: McCharacterKit): Promise<Buffer> {
    const asset = await this.view.resolveIdentityAsset(kit);
    if (asset?.fileUrl) {
      const buffer = await this.storage.readUploadsFile(asset.fileUrl);
      if (buffer) return buffer;
      throw new Error('Arquivo da identidade do kit não encontrado no disco');
    }
    return this.loadLogo(kit);
  }

  /** Referências de estilo opcionais (caminhos absolutos de MC_KIT_STYLE_REFS_DIR); ausentes = só o logo. */
  private async loadStyleReferences(kit: McCharacterKit): Promise<Buffer[]> {
    const refs: Buffer[] = [];
    for (const file of await listStyleReferences(kit.style)) {
      const buffer = await fs.readFile(file).catch(() => null);
      if (buffer) refs.push(buffer);
    }
    return refs;
  }

  // ─────────────────────────────── desfechos ───────────────────────────────

  /** Cerca de rodada para o CAS terminal: a MESMA UPDATE exige `candidateRoundId = roundId`. */
  private sameRound(roundId: string) {
    return { sql: '"candidateRoundId" = :roundId', params: { roundId } };
  }

  /** Releitura da cerca: a rodada ainda é a corrente e o kit segue no estado esperado. */
  private async roundStillOpen(
    kitId: string,
    roundId: string,
    expected: McKitStatus,
  ): Promise<boolean> {
    const fresh = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    return !!fresh && fresh.candidateRoundId === roundId && fresh.status === expected;
  }

  private async finishMouthVariant(
    kit: McCharacterKit,
    roundId: string,
    ready: number,
  ): Promise<void> {
    // A rodada pode ter sido fechada durante a geração (candidato escolhido)
    // ou o kit aprovado: o aviso "variante pronta" seria falso para a UI.
    const fresh = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kit.id });
    if (!fresh || fresh.candidateRoundId !== roundId || fresh.status !== McKitStatus.REVIEW) {
      this.logger.warn(
        `Kit ${kit.id}: rodada ${roundId} (mouth_variant) fechada antes de terminar.`,
      );
      return;
    }
    await this.dataSource.transaction(async (manager) => {
      // Variante falhou: a rodada fecha (cercada por ela mesma) para o
      // usuário poder pedir outra já — senão MOUTH_VARIANT_IN_PROGRESS a
      // bloquearia até a janela de expiração do job (L3).
      if (ready === 0) {
        await manager.update(
          McCharacterKit,
          { id: kit.id, candidateRoundId: roundId },
          { candidateRoundId: null },
        );
      }
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: ready > 0 ? 'mouth_variant_ready' : 'mouth_variant_failed',
        detail: { roundId, ready },
      });
      await this.notify(
        manager,
        kit,
        McKitStatus.REVIEW,
        ready > 0 ? 'mouth_variant_ready' : 'mouth_variant_failed',
      );
    });
  }

  /**
   * Rodada sem candidato: volta para `candidates` apontando para a última
   * rodada com imagens (ou vazia, quando "usar como está" é possível); sem
   * nada a que voltar, o kit falha.
   */
  private async roundFailed(
    kit: McCharacterKit,
    kind: string,
    roundId: string,
    message: string,
  ): Promise<void> {
    this.logger.warn(`Kit ${kit.id}: rodada ${roundId} (${kind}) falhou: ${message}`);
    if (kind === 'mouth_variant') {
      await this.finishMouthVariant(kit, roundId, 0);
      return;
    }
    const previous = await this.dataSource.getRepository(McKitCandidate).findOne({
      where: { kitId: kit.id, assetId: Not(IsNull()) },
      order: { createdAt: 'DESC' },
    });
    const canUseAsIs = decideMouthGate(kit.mouthGate?.logo) === 'passed';
    const to = previous || canUseAsIs ? McKitStatus.CANDIDATES : McKitStatus.FAILED;
    assertKitTransition(McKitStatus.GENERATING, to);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.GENERATING,
        to,
        to === McKitStatus.CANDIDATES ? { candidateRoundId: previous?.roundId ?? null } : {},
        this.sameRound(roundId),
      );
      if (!won) return;
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.GENERATING,
        toStatus: to,
        detail: {
          errorCode: 'candidates_generation_failed',
          errorMessage: message.slice(0, 300),
          roundId,
          fallbackRoundId: previous?.roundId ?? null,
        },
      });
      await this.notify(manager, kit, to, 'candidates_round_failed');
    });
  }

  private async notify(
    manager: EntityManager,
    kit: McCharacterKit,
    status: McKitStatus,
    event: string,
  ): Promise<void> {
    await this.transitions.notify(
      manager,
      kit.userId,
      { kind: 'mc_kit', kitId: kit.id, status, event },
      MC_EVENTS_CHANNEL,
    );
  }
}
