import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import {
  ApproveProductionDto,
  RegeneratePreviewDto,
  RevisionDto,
  SelectPreviewDto,
  UpdateCompositionDto,
  UpdateDialogueV2Dto,
  UpdateScriptV2Dto,
} from './dto/quality-v2.dto';
import { UpdateDialogueDto, UpdateScriptDto } from './dto/update-script.dto';
import { VoicePreviewDto } from './dto/voice-preview.dto';
import { isPipelineV2, McPhase } from './domain/mc-quality';
import { McEnabledGuard } from './mc-enabled.guard';
import { McKitsService } from './services/mc-kits.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McQualityService } from './services/mc-quality.service';
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
    private readonly quality: McQualityService,
    private readonly settings: SystemSettingsService,
    private readonly configService: ConfigService,
  ) {}

  /** Rotas compartilhadas entre executores despacham pelo `pipelineVersion` do projeto. */
  private async isV2(userId: string, projectId: string): Promise<boolean> {
    const project = await this.commercials.findOneProject(userId, projectId);
    return isPipelineV2(project);
  }

  private static isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  private static parseIdx(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(
        'Parâmetro da cena precisa ser o índice (legado) ou o sceneId (v2).',
      );
    }
    return Number(value);
  }

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

  /** Vozes visíveis para o usuário: curadas + as de que ele é dono (D10). */
  @Get('voices')
  listVoices(@CurrentUser() user: { id: string }) {
    return this.voices.list(user.id);
  }

  /** Preview de TTS (multilingual_v2 → eleven_v3), com cache e teto diário. */
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

  /**
   * Edição do roteiro. Legado: só storyboard_review, substitui por posição.
   * V2 (ADR-001): por identidade de cena, exige `expectedRevision`, abre nova
   * revisão (409 REVISION_CONFLICT em escrita concorrente antiga).
   */
  @Patch('projects/:id/script')
  async updateScript(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScriptDto | UpdateScriptV2Dto,
  ) {
    if (await this.isV2(user.id, id)) {
      return this.quality.updateScript(user.id, id, dto as UpdateScriptV2Dto);
    }
    return this.actions.updateScript(user.id, id, dto as UpdateScriptDto);
  }

  /**
   * Re-roll da cena ("veio errado", plano §6.3): 1º grátis; do 2º em diante
   * custa. Legado por `idx`; v2 por `sceneId` (uuid) com `expectedRevision`,
   * usando as prévias aprovadas (nunca dispara preparação nem nova aprovação).
   */
  @Post('projects/:id/scenes/:scene/reroll')
  rerollScene(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scene') scene: string,
    @Body() dto: Partial<RevisionDto> | undefined,
  ) {
    if (CommercialsController.isUuid(scene)) {
      if (dto?.expectedRevision == null) {
        throw new BadRequestException('expectedRevision é obrigatório no pipeline v2.');
      }
      return this.quality.rerollScene(user.id, id, scene, dto.expectedRevision);
    }
    return this.actions.rerollScene(user.id, id, CommercialsController.parseIdx(scene));
  }

  /** Regravar a fala da cena. Legado por `idx`; v2 por `sceneId` (nova revisão + TTS novo, vídeo preservado quando couber). */
  @Patch('projects/:id/scenes/:scene/dialogue')
  updateDialogue(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scene') scene: string,
    @Body() dto: UpdateDialogueDto | UpdateDialogueV2Dto,
  ) {
    if (CommercialsController.isUuid(scene)) {
      const v2 = dto as UpdateDialogueV2Dto;
      if (v2.expectedRevision == null) {
        throw new BadRequestException('expectedRevision é obrigatório no pipeline v2.');
      }
      return this.quality.updateDialogue(user.id, id, scene, v2);
    }
    return this.actions.updateDialogue(
      user.id,
      id,
      CommercialsController.parseIdx(scene),
      dto.dialogue,
    );
  }

  /** Cancela a geração com estorno do não consumido (legado: generating|needs_attention; v2: também fases novas). */
  @Post('projects/:id/cancel')
  async cancelProject(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    if (await this.isV2(user.id, id)) return this.quality.cancel(user.id, id);
    return this.actions.cancelProject(user.id, id);
  }

  // ───────────────────────── pipeline v2 (ADR-001) ─────────────────────────

  /** Converte um projeto legado (storyboard_review|succeeded) para o pipeline v2 — nova revisão, entrega preservada. */
  @Post('projects/:id/convert')
  convertToV2(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.quality.convertToV2(user.id, id);
  }

  /** Estimativa de uma fase ANTES de executar (sem reservar): ?phase=preparation|production|assembly. */
  @Get('projects/:id/quote')
  quote(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Query('phase') phase: string | undefined,
  ) {
    const value = (phase ?? 'preparation') as McPhase;
    if (!['preparation', 'production', 'assembly'].includes(value)) {
      throw new BadRequestException('phase inválida');
    }
    return this.quality.quote(user.id, id, value);
  }

  /** Gera SOMENTE prévias (imagem/TTS) da revisão — nunca vídeo. Cache integral ⇒ revisão visual imediata. */
  @Post('projects/:id/prepare')
  prepare(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevisionDto,
  ) {
    return this.quality.prepare(user.id, id, dto.expectedRevision);
  }

  /** Regenera imagem ou voz de uma cena (tentativa explícita, orçada à parte). */
  @Post('projects/:id/scenes/:sceneId/previews')
  regeneratePreview(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sceneId', ParseUUIDPipe) sceneId: string,
    @Body() dto: RegeneratePreviewDto,
  ) {
    return this.quality.regeneratePreview(user.id, id, sceneId, dto);
  }

  /** Escolhe entre as alternativas geradas de imagem/voz da cena. */
  @Patch('projects/:id/scenes/:sceneId/preview-selection')
  selectPreview(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sceneId', ParseUUIDPipe) sceneId: string,
    @Body() dto: SelectPreviewDto,
  ) {
    return this.quality.selectPreview(user.id, id, sceneId, dto);
  }

  /** GATE de vídeo: revisão + hash do manifesto + orçamento aceito; CAS e enqueue atômicos. */
  @Post('projects/:id/approve-production')
  approveProduction(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveProductionDto,
  ) {
    return this.quality.approveProduction(user.id, id, dto);
  }

  /** Correção só de composição após a entrega (preço/selo/cartela/trilha/ordem) — abre revisão assembly_only. */
  @Patch('projects/:id/composition')
  updateComposition(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompositionDto,
  ) {
    return this.quality.updateComposition(user.id, id, dto);
  }

  /** Aprova a remontagem editorial: só montagem, com os clipes existentes. */
  @Post('projects/:id/approve-assembly')
  approveAssembly(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevisionDto,
  ) {
    return this.quality.approveAssembly(user.id, id, dto.expectedRevision);
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
