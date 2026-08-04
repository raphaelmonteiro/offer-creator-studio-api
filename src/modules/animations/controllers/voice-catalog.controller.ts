import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { VoiceCatalogEntry } from '../entities/voice-catalog.entity';

/** Vozes padrão exibidas enquanto o catálogo curado (seed/admin) está vazio. */
const DEFAULT_VOICES = [
  { id: 'default-1', providerVoiceId: 'pNInz6obpgDQGcFmaJgB', name: 'Locutor Promocional', language: 'pt-BR', gender: 'male', style: 'enérgico', previewUrl: null },
  { id: 'default-2', providerVoiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Apresentadora', language: 'pt-BR', gender: 'female', style: 'institucional', previewUrl: null },
  { id: 'default-3', providerVoiceId: 'onwK4e9ZLuTAKqWW03F9', name: 'Narrador Jovem', language: 'pt-BR', gender: 'male', style: 'descontraído', previewUrl: null },
];

@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/voices')
export class VoiceCatalogController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async findAll() {
    const voices = await this.dataSource.getRepository(VoiceCatalogEntry).find({
      where: { enabled: true },
      order: { sort: 'ASC', name: 'ASC' },
    });
    return voices.length > 0 ? voices : DEFAULT_VOICES;
  }
}
