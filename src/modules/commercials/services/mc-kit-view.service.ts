import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { KIT_FRONT_SLOT } from '../domain/kit-prompts';
import { decideMouthGate, McMouthDecision } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';

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

export type McKitView = McCharacterKit & {
  references: KitReferenceView[];
  /** Identidade efetiva: `identityAssetId` ou a referência frontal (slot 2) do kit de mascote. */
  identity: KitAssetView | null;
  tile: KitAssetView | null;
  /** "Usar o logo como está" disponível: kit de logo em candidatos com o gate de boca aprovado no logo cru. */
  useAsIsAvailable: boolean;
  /** Decisão do gate de boca sobre o logo cru e sobre a identidade avaliada (null = ainda não rodou). */
  mouthGateStatus: { logo: McMouthDecision | null; identity: McMouthDecision | null };
};

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

  async findOne(userId: string, id: string): Promise<McKitView> {
    return this.toView(await this.findOwned(userId, id));
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
    const refIds = kit.referenceAssetIds ?? [];
    const ids = [...refIds, kit.identityAssetId, kit.tileAssetId].filter(
      (id): id is string => !!id,
    );
    const assets =
      ids.length > 0
        ? await this.dataSource.getRepository(AnimationAsset).find({ where: { id: In(ids) } })
        : [];
    const byId = new Map(assets.map((a) => [a.id, a]));
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
      : assets.find((a) => refIds.includes(a.id) && a.metadata?.slot === KIT_FRONT_SLOT);
    const tileAsset = kit.tileAssetId ? byId.get(kit.tileAssetId) : undefined;
    const logoDecision = kit.mouthGate?.logo ? decideMouthGate(kit.mouthGate.logo) : null;
    return {
      ...kit,
      references,
      identity: identityAsset ? { assetId: identityAsset.id, url: identityAsset.fileUrl } : null,
      tile: tileAsset ? { assetId: tileAsset.id, url: tileAsset.fileUrl } : null,
      useAsIsAvailable:
        kit.source === 'logo' &&
        kit.status === McKitStatus.CANDIDATES &&
        kit.identityMode === 'generated' &&
        logoDecision === 'passed',
      mouthGateStatus: {
        logo: logoDecision,
        identity: kit.mouthGate?.identity ? decideMouthGate(kit.mouthGate.identity) : null,
      },
    };
  }
}
