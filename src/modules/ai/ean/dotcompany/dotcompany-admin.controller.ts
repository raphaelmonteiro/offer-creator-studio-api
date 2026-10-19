import {
  BadRequestException,
  Controller,
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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../../common/decorators/public.decorator';
import { SkipValidation } from '../../../../common/decorators/skip-validation.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { assertAdminToken, DotcompanyAdminTokenGuard } from './dotcompany-admin-token.guard';
import { DotcompanyBudgetService } from './dotcompany-budget.service';
import { DotcompanyLookupService } from './dotcompany-lookup.service';
import { IMPORT_ITEM_RESULTS, ImportItemResult } from './dotcompany.types';
import { EanImportJobService } from './ean-import-job.service';
import { EanImportRunner } from './ean-import.runner';

/** Cadastro de cliente em CSV/XLSX: 20 MB sobra; o limite padrão de 50 MB não se justifica aqui. */
export const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCredits(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new BadRequestException(
      `${name} precisa ser um inteiro ≥ 0 (créditos; 1 crédito = R$ 0,01).`,
    );
  return n;
}

/**
 * Rotas administrativas da integração DotCompany (porta de script,
 * `x-admin-token`, como as demais rotas admin da galeria).
 */
@ApiTags('AI — catálogo DotCompany (admin)')
@Controller('ai/dotcompany')
export class DotcompanyAdminController {
  constructor(
    private readonly budget: DotcompanyBudgetService,
    private readonly config: ConfigService,
    private readonly jobs: EanImportJobService,
    private readonly runner: EanImportRunner,
    private readonly lookups: DotcompanyLookupService,
  ) {}

  protected assertAdminToken(token: string | undefined): void {
    assertAdminToken(this.config.get<string>('ADMIN_API_TOKEN'), token);
  }

  @Public()
  @Get('usage')
  @ApiOperation({
    summary: '[Admin] Saldo, consumo (hora/dia/mês), limites e estado do controlador DotCompany',
  })
  async usage(@Headers('x-admin-token') token: string | undefined) {
    this.assertAdminToken(token);
    return this.budget.report();
  }

  @Public()
  @Post('usage/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Confere o saldo agora na DotCompany (GET /usage, grátis)' })
  async refreshUsage(@Headers('x-admin-token') token: string | undefined) {
    this.assertAdminToken(token);
    // Falha ao conferir (sem token, credencial recusada, rede) não é erro 500:
    // devolve o relatório com o saldo conhecido e o motivo.
    let refreshError: string | null = null;
    try {
      await this.budget.refreshBalance();
    } catch (err) {
      refreshError = (err as Error).message;
    }
    return { ...(await this.budget.report()), refreshError };
  }

  @Public()
  @Get('lookup/:ean')
  @ApiOperation({
    summary:
      '[Admin] Consulta 1 EAN (cache primeiro; cobra 4 créditos se for à DotCompany e achar)',
  })
  async lookup(@Headers('x-admin-token') token: string | undefined, @Param('ean') ean: string) {
    this.assertAdminToken(token);
    const r = await this.lookups.resolve([ean], { kind: 'interactive' });
    const o = r.outcomes.get(ean);
    return {
      ean: o?.ean ?? ean,
      status: o?.status ?? 'error',
      cached: o?.cached ?? false,
      reason: o?.reason ?? null,
      blockReason: o?.blockReason ?? null,
      retryAt: o?.retryAt ?? null,
      credits: r.credits,
      product: o?.product ?? null,
      galleryImageId: o?.lookup?.galleryImageId ?? null,
    };
  }

  @Public()
  @Post('import-jobs/preview')
  @HttpCode(HttpStatus.OK)
  @SkipValidation()
  @UseGuards(DotcompanyAdminTokenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_FILE_MAX_BYTES } }))
  @ApiOperation({
    summary: '[Admin] Simula o CSV/XLSX contra a galeria, sem gravar nem chamar APIs externas',
  })
  async previewJob(
    @Headers('x-admin-token') token: string | undefined,
    @UploadedFile() file: Express.Multer.File,
  ) {
    this.assertAdminToken(token);
    if (!file?.buffer?.length)
      throw new BadRequestException('Envie o arquivo no campo "file" (CSV ou XLSX).');
    return this.jobs.previewArquivo(file.buffer);
  }

  @Public()
  @Post('import-jobs')
  @HttpCode(HttpStatus.CREATED)
  @SkipValidation()
  // O guard roda antes do interceptor: sem token válido o arquivo nem é lido.
  @UseGuards(DotcompanyAdminTokenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_FILE_MAX_BYTES } }))
  @ApiOperation({
    summary:
      '[Admin] Sobe o cadastro do cliente (CSV/XLSX com EAN) e cria o job de importação (roda em 2º plano)',
  })
  async criarJob(
    @Headers('x-admin-token') token: string | undefined,
    @UploadedFile() file: Express.Multer.File,
    @Query('clientId') clientId?: string,
    @Query('costCapCredits') costCap?: string,
  ) {
    this.assertAdminToken(token);
    if (!file?.buffer?.length)
      throw new BadRequestException('Envie o arquivo no campo "file" (CSV ou XLSX).');
    if (clientId && !UUID_RE.test(clientId)) throw new BadRequestException('clientId inválido.');
    const r = await this.jobs.criarJobDeArquivo(file.buffer, {
      fileName: file.originalname ?? null,
      clientId: clientId || null,
      costCapCredits: parseCredits(costCap, 'costCapCredits'),
    });
    if (r.created) this.runner.wake();
    return r;
  }

  @Public()
  @Get('import-jobs')
  @ApiOperation({ summary: '[Admin] Lista os jobs de importação com contagens e custo' })
  async listarJobs(
    @Headers('x-admin-token') token: string | undefined,
    @Query('limit') limit?: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.listar(limit ? Number(limit) : undefined);
  }

  @Public()
  @Get('import-jobs/:id')
  @ApiOperation({ summary: '[Admin] Detalhe do job: status, motivo de espera, contagens e custo' })
  async detalhe(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.detalhe(id);
  }

  @Public()
  @Get('import-jobs/:id/items')
  @ApiOperation({
    summary: '[Admin] Linhas do job, filtráveis por resultado (ex.: not_found, error, pending)',
  })
  async itens(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('result') result?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertAdminToken(token);
    if (
      result &&
      result !== 'pending' &&
      !IMPORT_ITEM_RESULTS.includes(result as ImportItemResult)
    ) {
      throw new BadRequestException(
        `result inválido. Use: pending, ${IMPORT_ITEM_RESULTS.join(', ')}.`,
      );
    }
    return this.jobs.itens(id, {
      result: (result as ImportItemResult | 'pending') || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Public()
  @Post('import-jobs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Pausa o job (só volta com resume)' })
  async pausar(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.assertAdminToken(token);
    return this.jobs.pausar(id);
  }

  @Public()
  @Post('import-jobs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Retoma o job (opcional: novo teto em costCapCredits)' })
  async retomar(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('costCapCredits') costCap?: string,
  ) {
    this.assertAdminToken(token);
    const job = await this.jobs.retomar(id, parseCredits(costCap, 'costCapCredits'));
    this.runner.wake();
    return job;
  }
}
