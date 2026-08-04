import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { AnimationAsset } from '../entities/animation-asset.entity';
import { ttsCacheKey } from '../domain/tts-cache-key';

/**
 * Cache de TTS (TDD §5.3): dedupe por sha256(texto+voiceId+settings),
 * escopado por usuário (evita vazamento de conteúdo entre contas).
 */
@Injectable()
export class TtsCacheService {
  computeKey(text: string, voiceId: string, settings?: Record<string, unknown>): string {
    return ttsCacheKey({ text, voiceId, settings });
  }

  /** Asset de áudio `ready|approved` do MESMO usuário com o mesmo hash, se existir. */
  async findCached(
    manager: EntityManager,
    userId: string,
    contentHash: string,
  ): Promise<AnimationAsset | null> {
    return manager.findOne(AnimationAsset, {
      where: [
        { userId, contentHash, kind: 'audio', status: 'ready', deletedAt: IsNull() },
        { userId, contentHash, kind: 'audio', status: 'approved', deletedAt: IsNull() },
      ],
      order: { createdAt: 'DESC' },
    });
  }
}
