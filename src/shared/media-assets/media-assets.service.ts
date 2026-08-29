import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { AnimationAsset } from './animation-asset.entity';

/**
 * Acesso compartilhado à biblioteca de mídias (`animation_assets`) — os
 * pedaços de busca por id/ownership usados pelos processors, extraídos de
 * modules/animations (plano-comerciais §11). Soft-delete é respeitado por
 * padrão (mesmo comportamento dos repositórios TypeORM usados antes).
 */
@Injectable()
export class MediaAssetsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Busca por id; lança EntityNotFoundError se não existir (ou estiver soft-deletado). */
  findByIdOrFail(id: string): Promise<AnimationAsset> {
    return this.dataSource.getRepository(AnimationAsset).findOneByOrFail({ id });
  }

  /** Busca por id; null se não existir (ou estiver soft-deletado). */
  findById(id: string): Promise<AnimationAsset | null> {
    return this.dataSource.getRepository(AnimationAsset).findOneBy({ id });
  }

  /** Busca com verificação de ownership — 404 se não existe, 403 se de outro usuário. */
  async findOwned(userId: string, id: string): Promise<AnimationAsset> {
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOne({ where: { id, deletedAt: IsNull() } });
    if (!asset) throw new NotFoundException('Asset não encontrado');
    if (asset.userId !== userId) throw new ForbiddenException();
    return asset;
  }
}
