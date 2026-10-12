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
    const repo = this.dataSource.getRepository(VoiceCatalogEntry);
    const voices = await repo.find({
      where: applyVoiceVisibility({}, user.id),
      order: { sort: 'ASC', name: 'ASC' },
    });
    if (voices.length > 0) return voices;
    // As vozes padrão só cobrem o catálogo VAZIO (seed/sync ainda não rodou).
    // Catálogo com linhas e nenhuma visível para este usuário é um estado
    // normal do predicado de tenant: devolve lista vazia, nunca ids fora do catálogo.
    const total = await repo.count();
    return total === 0 ? DEFAULT_VOICES : [];
  }
}
