import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { Mascot } from '../../mascots/entities/mascot.entity';
import { KIT_FRONT_SLOT } from '../domain/kit-prompts';
import {
  MC_KIT_COST_FAILURES,
  McCallUsage,
  McKitCostCall,
  McKitCostFailure,
} from '../domain/mc-kit-costs';
import { decideMouthGate, McMouthDecision } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';
import { MC_TILE_MIN_FACE_FRACTION } from '../domain/mc-tile';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McEvent } from '../entities/mc-event.entity';
import { MC_KIT_COST_EVENT } from './mc-kit-costs';

/** Referência do kit resolvida para a UI de review (grid por slot, plano §4). */
export interface KitReferenceView {
  assetId: string;
  slot: number | null;
  url: string | null;
  createdAt: Date;
}

export interface KitAssetView {
  assetId: string;
  url: string | null;
}

/** Tile do personagem com a fração do rosto medida no recorte (spec "Tile do personagem": ≥ 60%). */
export interface KitTileView extends KitAssetView {
  /** Altura do rosto / altura do tile; null em `logo_as_is` (logo inteiro, sem caixa). */
  faceFraction: number | null;
  /** Rosto abaixo de 60% da altura (rosto muito largo: a proporção mandou) — a UI avisa, não bloqueia. */
  faceBelowMinimum: boolean;
}

/** Uma chamada paga do kit (evento `provider_cost`), na ordem em que aconteceu. */
export interface KitProviderCostView {
  call: McKitCostCall;
  provider: string;
  model: string;
  /** US$; null = modelo fora da tabela de tarifas (MC_KIT_PRICES). */
  costUsd: number | null;
  usage: McCallUsage | null;
  /** Asset gerado pela chamada (referência, candidato), quando há. */
  assetId: string | null;
  /** Chamada paga sem resultado (resposta sem imagem/texto, timeout, rede depois do envio); null = entregou. */
  failure: McKitCostFailure | null;
  /** true = custo estimado (timeout, falha de rede depois do envio), não medido. */
  estimated: boolean;
  at: Date;
}

/** Teto de linhas de custo devolvidas no GET do kit (um kit real tem ~5 a 15 chamadas). */
const KIT_COST_LINES_MAX = 200;

export type McKitView = McCharacterKit & {
  /** Chamadas pagas, uma por linha — só no GET /commercials/kits/:id (a soma é `providerCostUsd`). */
  providerCosts?: KitProviderCostView[];
  references: KitReferenceView[];
  /** Identidade efetiva: `identityAssetId` ou a referência frontal (slot 2) do kit de mascote. */
  identity: KitAssetView | null;
  tile: KitTileView | null;
  /** "Usar o logo como está" disponível (ver `kitUseAsIsAvailable`). */
  useAsIsAvailable: boolean;
  /** Decisão do gate de boca sobre o logo cru e sobre a identidade avaliada (null = ainda não rodou). */
  mouthGateStatus: { logo: McMouthDecision | null; identity: McMouthDecision | null };
  /** Nome do mascote/logo de origem (`mascots.name`); null quando o cadastro não existe mais. */
  mascotName: string | null;
  /** Rótulo pronto para a UI: o nome da origem, senão "Kit <id curto>" — sem depender de GET /mascots. */
  label: string;
};

/**
 * "Usar o logo como está" (spec "Logo usado como está"): kit de logo ainda
 * sem identidade fixada, com o gate de boca aprovado no logo cru, em
 * `candidates` (rodada pronta) ou em `generating` com uma rodada de
 * candidatos em andamento — o usuário não precisa esperar a mascotização
 * terminar para dispensá-la; o CAS da rodada em voo vira no-op. `generating`
 * SEM rodada (referências em voo depois de uma escolha) não oferece.
 */
export function kitUseAsIsAvailable(
  kit: Pick<
    McCharacterKit,
    'source' | 'status' | 'identityMode' | 'mouthGate' | 'candidateRoundId'
  >,
): boolean {
  if (kit.source !== 'logo' || kit.identityMode !== 'generated') return false;
  if (decideMouthGate(kit.mouthGate?.logo) !== 'passed') return false;
  return (
    kit.status === McKitStatus.CANDIDATES ||
    (kit.status === McKitStatus.GENERATING && !!kit.candidateRoundId)
  );
}

/** Rótulo do kit para listas e seletores (mesma regra no backend para toda tela). */
export function kitLabel(kit: Pick<McCharacterKit, 'id'>, mascotName: string | null): string {
  return mascotName?.trim() || `Kit ${kit.id.slice(0, 8)}`;
}

/**
 * Leitura do kit para a API: ownership (404/403) e a view com os assets
 * resolvidos em URLs. Extraído do McKitsService para os services de
 * candidatos e de tile devolverem a mesma forma sem dependência circular.
 */
@Injectable()
export class McKitViewService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findOwned(userId: string, id: string): Promise<McCharacterKit> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id });
    if (!kit) throw new NotFoundException('Kit não encontrado');
    if (kit.userId !== userId) throw new ForbiddenException();
    return kit;
  }

  /** Ficha do kit com as linhas de custo (GET /commercials/kits/:id). */
  async findOne(userId: string, id: string): Promise<McKitView> {
    const kit = await this.findOwned(userId, id);
    const [view, providerCosts] = await Promise.all([this.toView(kit), this.costLines(kit.id)]);
    return { ...view, providerCosts };
  }

  /** Linhas de custo do kit (eventos `provider_cost`), da mais antiga para a mais nova. */
  async costLines(kitId: string): Promise<KitProviderCostView[]> {
    const events = await this.dataSource.getRepository(McEvent).find({
      where: { refKind: 'kit', refId: kitId, kind: MC_KIT_COST_EVENT },
      order: { id: 'ASC' },
      take: KIT_COST_LINES_MAX,
    });
    return events.map((event) => {
      const detail = (event.detail ?? {}) as Record<string, unknown>;
      const cost = detail.costUsd;
      return {
        call: detail.call as McKitCostCall,
        provider: typeof detail.provider === 'string' ? detail.provider : 'unknown',
        model: typeof detail.model === 'string' ? detail.model : 'unknown',
        costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
        usage: (detail.usage as McCallUsage | null | undefined) ?? null,
        assetId: typeof detail.assetId === 'string' ? detail.assetId : null,
        failure: MC_KIT_COST_FAILURES.includes(detail.failure as McKitCostFailure)
          ? (detail.failure as McKitCostFailure)
          : null,
        estimated: detail.estimated === true,
        at: event.createdAt,
      };
    });
  }

  /** Asset da identidade efetiva (candidato escolhido / logo como está / referência frontal). */
  async resolveIdentityAsset(kit: McCharacterKit): Promise<AnimationAsset | null> {
    const repo = this.dataSource.getRepository(AnimationAsset);
    if (kit.identityAssetId) return repo.findOneBy({ id: kit.identityAssetId });
    if ((kit.referenceAssetIds ?? []).length === 0) return null;
    const refs = await repo.find({ where: { id: In(kit.referenceAssetIds) } });
    return refs.find((a) => a.metadata?.slot === KIT_FRONT_SLOT) ?? null;
  }

  /** Resolve referências, identidade e tile em URLs para a UI (slot vem do metadata do asset). */
  async toView(kit: McCharacterKit): Promise<McKitView> {
    const [view] = await this.toViewMany([kit]);
    return view;
  }

  /** Mesma view para N kits com UMA consulta de assets e UMA de mascotes (lista de kits). */
  async toViewMany(kits: McCharacterKit[]): Promise<McKitView[]> {
    if (kits.length === 0) return [];
    const assetIds = new Set<string>();
    const mascotIds = new Set<string>();
    for (const kit of kits) {
      for (const id of kit.referenceAssetIds ?? []) assetIds.add(id);
      if (kit.identityAssetId) assetIds.add(kit.identityAssetId);
      if (kit.tileAssetId) assetIds.add(kit.tileAssetId);
      if (kit.mascotId) mascotIds.add(kit.mascotId);
    }
    const [assets, mascots] = await Promise.all([
      assetIds.size > 0
        ? this.dataSource.getRepository(AnimationAsset).find({ where: { id: In([...assetIds]) } })
        : Promise.resolve([] as AnimationAsset[]),
      mascotIds.size > 0
        ? this.dataSource
            .getRepository(Mascot)
            .find({ where: { id: In([...mascotIds]) }, select: ['id', 'name'] })
        : Promise.resolve([] as Pick<Mascot, 'id' | 'name'>[]),
    ]);
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const mascotNameById = new Map(mascots.map((m) => [m.id, m.name]));
    return kits.map((kit) => this.buildView(kit, assetById, mascotNameById));
  }

  private buildView(
    kit: McCharacterKit,
    byId: Map<string, AnimationAsset>,
    mascotNameById: Map<string, string>,
  ): McKitView {
    const refIds = kit.referenceAssetIds ?? [];
    const references = refIds
      .map((id) => byId.get(id))
      .filter((asset): asset is AnimationAsset => !!asset)
      .map((asset) => ({
        assetId: asset.id,
        slot: typeof asset.metadata?.slot === 'number' ? (asset.metadata.slot as number) : null,
        url: asset.fileUrl,
        createdAt: asset.createdAt,
      }))
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
    const identityAsset = kit.identityAssetId
      ? byId.get(kit.identityAssetId)
      : refIds.map((id) => byId.get(id)).find((a) => a?.metadata?.slot === KIT_FRONT_SLOT);
    const tileAsset = kit.tileAssetId ? byId.get(kit.tileAssetId) : undefined;
    const faceFraction =
      typeof tileAsset?.metadata?.faceFraction === 'number'
        ? (tileAsset.metadata.faceFraction as number)
        : null;
    const logoDecision = kit.mouthGate?.logo ? decideMouthGate(kit.mouthGate.logo) : null;
    const mascotName = mascotNameById.get(kit.mascotId) ?? null;
    // a entidade já traz número (transformer); Number() cobre linha crua/mocks
    const cost = Number(kit.providerCostUsd ?? 0);
    return {
      ...kit,
      providerCostUsd: Number.isFinite(cost) ? cost : 0,
      references,
      identity: identityAsset ? { assetId: identityAsset.id, url: identityAsset.fileUrl } : null,
      tile: tileAsset
        ? {
            assetId: tileAsset.id,
            url: tileAsset.fileUrl,
            faceFraction,
            faceBelowMinimum: faceFraction != null && faceFraction < MC_TILE_MIN_FACE_FRACTION,
          }
        : null,
      useAsIsAvailable: kitUseAsIsAvailable(kit),
      mouthGateStatus: {
        logo: logoDecision,
        identity: kit.mouthGate?.identity ? decideMouthGate(kit.mouthGate.identity) : null,
      },
      mascotName,
      label: kitLabel(kit, mascotName),
    };
  }
}
