import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { SkipValidation } from '../../../common/decorators/skip-validation.decorator';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { AdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { createFileInterceptor } from '../../../common/utils/multer.util';
import { EanReviewDecisionDto } from '../dto/ean-review-decision.dto';
import { EanCalibrationService } from './ean-calibration.service';
import { EanJudgeService } from './ean-judge.service';
import { EanMatchCommitService } from './ean-match-commit.service';
import { EanMatchJobService } from './ean-match-job.service';
import type { EanMatchItemStatus } from './ean-match.types';
import { EanReviewService } from './ean-review.service';

const parseNum = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

/**
 * Operações de job compartilhadas pelas duas portas de entrada: script
 * (x-admin-token) e tela de revisão (JWT de admin).
 */
class EanMatchOperacoes {
  constructor(
    protected readonly jobs: EanMatchJobService,
    protected readonly commit: EanMatchCommitService,
    protected readonly revisao: EanReviewService,
    protected readonly calibracao: EanCalibrationService,
    protected readonly juiz: EanJudgeService,
  ) {}

  protected async criar(
    file: Express.Multer.File | undefined,
    costCap?: string,
    clientId?: string,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException('Envie o arquivo no campo "file" (CSV ou XLSX).');
    const teto = parseNum(costCap);
    if (teto !== undefined && (!Number.isFinite(teto) || teto < 0)) {
      throw new BadRequestException('costCapUsd inválido');
    }
    return this.jobs.criarJob(file.buffer, {
      fileName: file.originalname ?? null,
      clientId: clientId || null,
      costCapUsd: teto,
    });
  }

  protected async calibracaoAtual() {
    return { judgeVersion: this.juiz.version(), resultado: await this.calibracao.estado() };
  }
}

/** Porta de script: `x-admin-token`, como as demais rotas admin da galeria. */
@ApiTags('AI — vínculo EAN (admin)')
@Controller('ai/ean')
export class EanMatchAdminController extends EanMatchOperacoes {
  constructor(
    jobs: EanMatchJobService,
    commit: EanMatchCommitService,
    revisao: EanReviewService,
    calibracao: EanCalibrationService,
    juiz: EanJudgeService,
    private readonly config: ConfigService,
  ) {
    super(jobs, commit, revisao, calibracao, juiz);
  }

  private assertAdminToken(token: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_API_TOKEN');
    if (!expected) throw new ForbiddenException('ADMIN_API_TOKEN não configurado no servidor.');
    if (!token || token !== expected)
      throw new ForbiddenException('Token administrativo inválido.');
  }

  @Public()
  @Post('jobs')
  @HttpCode(HttpStatus.CREATED)
  @SkipValidation()
  @UseInterceptors(createFileInterceptor('file'))
  @ApiOperation({
    summary:
      '[Admin] Sobe a planilha do cliente e cria um job de vínculo EAN (processa em 2º plano)',
  })
  async criarJob(
    @Headers('x-admin-token') token: string | undefined,
    @UploadedFile() file: Express.Multer.File,
    @Query('costCapUsd') costCap?: string,
    @Query('clientId') clientId?: string,
  ) {
    this.assertAdminToken(token);
    return this.criar(file, costCap, clientId);
  }

  @Public()
  @Get('jobs')
  @ApiOperation({ summary: '[Admin] Lista os jobs de vínculo EAN' })
  async listarJobs(@Headers('x-admin-token') token: string | undefined) {
    this.assertAdminToken(token);
    return this.jobs.listarJobs();
  }

  @Public()
  @Get('jobs/:id')
  @ApiOperation({ summary: '[Admin] Progresso do job: itens por status e custo acumulado' })
  async progresso(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.progresso(id);
  }

  @Public()
  @Get('jobs/:id/items')
  @ApiOperation({ summary: '[Admin] Itens do job, com toda a evidência' })
  async itens(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: EanMatchItemStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.listarItens(id, { status, limit: parseNum(limit), offset: parseNum(offset) });
  }

  @Public()
  @Post('jobs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Pausa o job' })
  async pausar(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.pausar(id);
  }

  @Public()
  @Post('jobs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Retoma o job; ?costCapUsd= eleva o teto' })
  async retomar(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('costCapUsd') costCap?: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.retomar(id, parseNum(costCap));
  }

  @Public()
  @Post('jobs/:id/revert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Desfaz todas as gravações do job na galeria' })
  async reverter(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.assertAdminToken(token);
    return this.commit.reverterJob(id);
  }

  @Public()
  @Post('jobs/:id/calibration-sample')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Separa amostra estratificada de calibração (?size=200)' })
  async amostra(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('size') size?: string,
  ) {
    this.assertAdminToken(token);
    return this.revisao.montarAmostraCalibracao(id, parseNum(size));
  }

  @Public()
  @Post('jobs/:id/reevaluate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Após calibração aprovada, aceita e grava o que só esperava por ela',
  })
  async reavaliar(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.assertAdminToken(token);
    return this.revisao.reavaliarAposCalibracao(id);
  }

  @Public()
  @Get('calibration')
  @ApiOperation({ summary: '[Admin] Versão atual do juiz e último resultado de calibração' })
  async calibracaoEstado(@Headers('x-admin-token') token: string | undefined) {
    this.assertAdminToken(token);
    return this.calibracaoAtual();
  }

  @Public()
  @Post('calibration/evaluate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '[Admin] Mede a regra contra os itens de calibração rotulados e liga/desliga o auto-aceite',
  })
  async avaliar(@Headers('x-admin-token') token: string | undefined) {
    this.assertAdminToken(token);
    return this.calibracao.avaliar(this.juiz.version());
  }
}

/** Porta da tela de revisão: JWT de usuário com `role = 'admin'`. */
@ApiTags('AI — revisão de EAN')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@Controller('ai/ean/review')
export class EanReviewController extends EanMatchOperacoes {
  // Construtor explícito: sem ele o Nest não lê os tipos dos parâmetros
  // (a classe base não é decorada) e injeta `undefined`.
  constructor(
    jobs: EanMatchJobService,
    commit: EanMatchCommitService,
    revisao: EanReviewService,
    calibracao: EanCalibrationService,
    juiz: EanJudgeService,
  ) {
    super(jobs, commit, revisao, calibracao, juiz);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Jobs de vínculo EAN, com progresso' })
  async jobsComProgresso() {
    const jobs = await this.jobs.listarJobs();
    return Promise.all(jobs.map((j) => this.jobs.progresso(j.id)));
  }

  @Post('jobs')
  @HttpCode(HttpStatus.CREATED)
  @SkipValidation()
  @UseInterceptors(createFileInterceptor('file'))
  @ApiOperation({ summary: 'Sobe a planilha do cliente e cria um job' })
  async criarJob(
    @UploadedFile() file: Express.Multer.File,
    @Query('costCapUsd') costCap?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.criar(file, costCap, clientId);
  }

  @Get('calibration')
  @ApiOperation({ summary: 'Versão do juiz e resultado da calibração' })
  async calibracaoEstado() {
    return this.calibracaoAtual();
  }

  @Post('calibration/evaluate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mede a calibração com as decisões já tomadas' })
  async avaliar() {
    return this.calibracao.avaliar(this.juiz.version());
  }

  @Post('jobs/:id/calibration-sample')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Separa amostra de calibração' })
  async amostra(@Param('id', ParseUUIDPipe) id: string, @Query('size') size?: string) {
    return this.revisao.montarAmostraCalibracao(id, parseNum(size));
  }

  @Post('jobs/:id/reevaluate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Após calibração aprovada, aceita e grava o que só esperava por ela' })
  async reavaliar(@Param('id', ParseUUIDPipe) id: string) {
    return this.revisao.reavaliarAposCalibracao(id);
  }

  @Get('items')
  @ApiOperation({ summary: 'Itens na fila de revisão (calibração primeiro)' })
  async fila(
    @Query('jobId') jobId?: string,
    @Query('calibration') calibracao?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.revisao.listar({
      jobId: jobId || undefined,
      calibracao: calibracao === undefined ? undefined : calibracao === 'true',
      limit: parseNum(limit),
      offset: parseNum(offset),
    });
  }

  @Get('items/:itemId')
  @ApiOperation({ summary: 'Um item com toda a evidência' })
  async item(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.revisao.buscar(itemId);
  }

  @Post('items/:itemId/decision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decisão do revisor: imagens | nenhuma | pular' })
  async decidir(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: EanReviewDecisionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.revisao.decidir(itemId, body, user.id);
  }
}
