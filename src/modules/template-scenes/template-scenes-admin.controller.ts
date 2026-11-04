import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { UploadsGcService } from '../../shared/gc/uploads-gc.service';
import { AdminGcDto } from './dto/admin-gc.dto';
import { adminTokenInvalid } from './scene.errors';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

/** Rota de script (sem JWT): `x-admin-token` contra `ADMIN_API_TOKEN`, como as demais rotas admin. */
@ApiTags('template-scenes (admin)')
@UseGuards(TemplateSceneEnabledGuard)
@Controller('template-scenes/admin')
export class TemplateScenesAdminController {
  constructor(
    private readonly gc: UploadsGcService,
    private readonly config: ConfigService,
  ) {}

  @Post('gc')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-admin-token', required: true })
  @ApiOperation({ summary: '[Admin] Dispara agora a limpeza dos arquivos das cenas' })
  runGc(@Headers('x-admin-token') token: string | undefined, @Body() dto: AdminGcDto) {
    this.assertAdminToken(token);
    return this.gc.runTemplateScenes({ dryRun: dto?.dryRun });
  }

  /** Sem token configurado no servidor, nenhum token vale (a rota fica fechada). */
  private assertAdminToken(token: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_API_TOKEN');
    if (!expected || !token) throw adminTokenInvalid();
    const given = Buffer.from(token);
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
      throw adminTokenInvalid();
  }
}
