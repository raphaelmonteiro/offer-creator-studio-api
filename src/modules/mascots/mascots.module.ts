import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { UploadsModule } from '../uploads/uploads.module';
import { Mascot } from './entities/mascot.entity';
import { MascotsController } from './mascots.controller';
import { MascotsService } from './mascots.service';
import { MascotRigService } from './services/mascot-rig.service';

/**
 * Mascote animado (spike docs/spike-mascote-animado.md).
 *
 * - Fase 1 (Abordagem D): upload, recorte, aceite de direitos e animação de
 *   presença sem IA — o piso, que continua valendo para mascote sem rig.
 * - Fase 3, fatia 1 (Abordagem C): rig 2D — o mascote é desmontado em peças
 *   (`MascotRigService`) e o usuário confere no editor. Gestos e lip-sync são
 *   as fatias 2 e 3.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Mascot]), UploadsModule, AiModule],
  controllers: [MascotsController],
  providers: [MascotsService, MascotRigService],
  exports: [MascotsService, MascotRigService],
})
export class MascotsModule {}
