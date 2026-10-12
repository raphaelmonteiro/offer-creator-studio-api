import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { VoiceCatalogEntry } from '../../../shared/voice/voice-catalog.entity';
import { applyVoiceVisibility } from '../../../shared/voice/voice-visibility';

/** Vozes padrão exibidas enquanto o catálogo curado (seed/admin) está vazio. */
const DEFAULT_VOICES = [
  {
    id: 'default-1',
    providerVoiceId: 'pNInz6obpgDQGcFmaJgB',
    name: 'Locutor Promocional',
    language: 'pt-BR',
    gender: 'male',
    style: 'enérgico',
    previewUrl: null,
  },
  {
    id: 'default-2',
    providerVoiceId: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Apresentadora',
    language: 'pt-BR',
    gender: 'female',
    style: 'institucional',
    previewUrl: null,
  },
  {
    id: 'default-3',
    providerVoiceId: 'onwK4e9ZLuTAKqWW03F9',
    name: 'Narrador Jovem',
    language: 'pt-BR',
    gender: 'male',
    style: 'descontraído',
    previewUrl: null,
  },
];

@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/voices')
export class VoiceCatalogController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Vozes visíveis para o usuário (D10): habilitadas E (curadas OU de que ele
   * é dono) — mesmo predicado de src/shared/voice/voice-visibility.ts que o
   * módulo commercials usa (sem cruzar a fronteira do ESLint).
   */
  @Get()
  async findAll(@CurrentUser() user: { id: string }) {
    const voices = await this.dataSource.getRepository(VoiceCatalogEntry).find({
      where: applyVoiceVisibility({}, user.id),
      order: { sort: 'ASC', name: 'ASC' },
    });
    return voices.length > 0 ? voices : DEFAULT_VOICES;
  }
}
