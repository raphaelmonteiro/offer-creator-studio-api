import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CommercialsService, MC_PAUSED_KEY } from './commercials.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { AdminPauseDto } from './dto/admin-pause.dto';
import { CreateKitDto } from './dto/create-kit.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { DuplicateProjectDto } from './dto/duplicate-project.dto';
import { ApproveKitDto, RegenerateReferenceDto, UpdateKitSheetDto } from './dto/kit-actions.dto';
import { UpdateDialogueDto, UpdateScriptDto } from './dto/update-script.dto';
import { VoicePreviewDto } from './dto/voice-preview.dto';
import { McEnabledGuard } from './mc-enabled.guard';
import { McKitsService } from './services/mc-kits.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McVoicesService } from './services/mc-voices.service';

/**
 * Rotas do módulo de comerciais, sob /v1 com o envelope { success, data } do
 * ResponseInterceptor global. McEnabledGuard responde 404 MC_DISABLED
 * enquanto MC_ENABLED !== 'true'. O SSE dedicado vive no McEventsController.
 */
@ApiTags('commercials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, McEnabledGuard)
@Controller('commercials')
export class CommercialsController {
  constructor(
    private readonly commercials: CommercialsService,
    private readonly kits: McKitsService,
    private readonly voices: McVoicesService,
    private readonly actions: McProjectActionsService,
    private readonly settings: SystemSettingsService,
    private readonly configService: ConfigService,
  ) {}

  /** Mesmo padrão das rotas admin do módulo ai (x-admin-token = ADMIN_API_TOKEN). */
  private assertAdminToken(token: string | undefined): void {
    const expected = this.configService.get<string>('ADMIN_API_TOKEN');
    if (!expected) {
      throw new ForbiddenException('ADMIN_API_TOKEN não configurado no servidor.');
    }
    if (!token || token !== expected) {
      throw new ForbiddenException('Token administrativo inválido.');
    }
  }

  // ───────────────────────────── kits (plano §4) ─────────────────────────────

  /** Fluxo real: valida mascote + direitos, modera a imagem e dispara a geração das referências. */
  @Post('kits')
  createKit(@CurrentUser() user: { id: string }, @Body() dto: CreateKitDto) {
    return this.kits.createKit(user.id, dto);
  }

  @Get('kits')
  findAllKits(@CurrentUser() user: { id: string }) {
    return this.kits.findAll(user.id);
  }

  @Get('kits/:id')
  findOneKit(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.kits.findOne(user.id, id);
  }

  /** Gate humano do kit (review → approved). Exige voz definida — aqui ou na criação. */
  @Post('kits/:id/approve')
  approveKit(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveKitDto,
  ) {
    return this.kits.approveKit(user.id, id, dto);
  }

  /** Regeneração por célula do grid (plano §4). Kit precisa estar em review. */
  @Post('kits/:id/regenerate-reference')
  regenerateReference(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegenerateReferenceDto,
  ) {
    return this.kits.regenerateReference(user.id, id, dto);
  }

  /** Ajuste da ficha do personagem (traços/acessórios/regras) — só em review. */
  @Patch('kits/:id/sheet')
  updateKitSheet(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKitSheetDto,
  ) {
    return this.kits.updateSheet(user.id, id, dto);
  }

  /** Traduz a ficha de kits antigos (geradas só em inglês) — sem refazer imagens. */
  @Post('kits/:id/sheet/translate')
  translateKitSheet(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.kits.translateSheet(user.id, id);
  }

  // ───────────────────────────── voz (plano §5.3) ─────────────────────────────

  @Get('voices')
  listVoices() {
    return this.voices.list();
  }

  /** Preview de TTS (eleven_v3 → multilingual_v2), com cache e teto diário. */
  @Post('voices/preview')
  previewVoice(@CurrentUser() user: { id: string }, @Body() dto: VoicePreviewDto) {
    return this.voices.preview(user.id, dto);
  }

  // ─────────────────────────────── projetos ───────────────────────────────

  @Post('projects')
  createProject(@CurrentUser() user: { id: string }, @Body() dto: CreateProjectDto) {
    return this.commercials.createProject(user.id, dto);
  }

  @Get('projects')
  findAllProjects(@CurrentUser() user: { id: string }) {
    return this.commercials.findAllProjects(user.id);
  }

  @Get('projects/:id')
  findOneProject(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.commercials.findOneProject(user.id, id);
  }

  /**
   * "Duplicar em outro formato" (plano §7.2): novo projeto em storyboard_review
   * com o MESMO roteiro e o formato escolhido — o TTS volta do cache por hash.
   */
  @Post('projects/:id/duplicate')
  duplicateProject(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateProjectDto,
  ) {
    return this.actions.duplicateProject(user.id, id, dto);
  }

  /** GATE humano do storyboard (plano §7.2): reserva principal + materializa cenas/steps + enfileira. */
  @Post('projects/:id/approve')
  approveStoryboard(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.approve(user.id, id);
  }

  /** Edição do roteiro ANTES de aprovar (só storyboard_review; re-moderação leve). */
  @Patch('projects/:id/script')
  updateScript(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScriptDto,
  ) {
    return this.actions.updateScript(user.id, id, dto);
  }

  /** Re-roll da cena ("veio errado", plano §6.3): 1º grátis; do 2º em diante custa custoDaCena. */
  @Post('projects/:id/scenes/:idx/reroll')
  rerollScene(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('idx', ParseIntPipe) idx: number,
  ) {
    return this.actions.rerollScene(user.id, id, idx);
  }

  /** Regravar a fala da cena (invalida SÓ tts+lipsync, plano §6.3). */
  @Patch('projects/:id/scenes/:idx/dialogue')
  updateDialogue(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Body() dto: UpdateDialogueDto,
  ) {
    return this.actions.updateDialogue(user.id, id, idx, dto.dialogue);
  }

  /** Cancela a geração (generating|needs_attention) com estorno do não consumido (plano §6.7). */
  @Post('projects/:id/cancel')
  cancelProject(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.cancelProject(user.id, id);
  }

  /**
   * Kill-switch operacional (plano §6.7): grava 'mc_paused' em
   * system_settings. Fica atrás do JWT global + McEnabledGuard E exige
   * x-admin-token — o createProject passa a responder 503 MC_PAUSED em até
   * 10s (TTL do cache do SystemSettingsService) em todos os processos.
   */
  @Post('admin/pause')
  @ApiOperation({ summary: '[Admin] Pausa/retoma a geração de comerciais' })
  async setPaused(
    @Headers('x-admin-token') adminToken: string | undefined,
    @Body() dto: AdminPauseDto,
  ) {
    this.assertAdminToken(adminToken);
    await this.settings.set(MC_PAUSED_KEY, dto.paused);
    return { paused: dto.paused };
  }
}
