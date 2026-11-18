import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { StartEnrichmentDto } from '../dto/start-enrichment.dto';
import { FlyerProJobsService } from '../services/flyer-pro-jobs.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';

/**
 * As rotas do job de enriquecimento (N14, N15 e N16), no mesmo prefixo das rotas do encarte, em controller próprio (A-29:
 * o de documentos já passa de 4 dependências). Qualquer usuário logado inicia, lê e para o job de qualquer encarte.
 */
@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents')
export class FlyerProEnrichmentController {
  constructor(private readonly jobs: FlyerProJobsService) {}

  @Post(':id/enrichment')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Inicia o job de categorias, ortografia e fotos do encarte; as fases rodam na ordem fixa, em lotes, no servidor',
  })
  @ApiResponse({ status: 202, description: 'O job lido (JobView), em status queued' })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: corpo vazio ou fora da forma' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  @ApiResponse({
    status: 409,
    description: 'FLYER_PRO_ENRICHMENT_RUNNING: já há job ativo (details.jobId)',
  })
  @ApiResponse({
    status: 422,
    description:
      'FLYER_PRO_ENRICHMENT_DISABLED (flag desligada) ou FLYER_PRO_NO_ITEMS (escopo vazio)',
  })
  start(
    @Param('id', DocumentIdPipe) id: string,
    @Body() dto: StartEnrichmentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.jobs.start(user.id, id, dto);
  }

  @Get(':id/enrichment')
  @ApiOperation({
    summary: 'O job ativo do encarte; sem ativo, o mais recente; sem nenhum, job: null. Não grava',
  })
  @ApiResponse({ status: 200, description: '{ job }' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  current(@Param('id', DocumentIdPipe) id: string) {
    return this.jobs.current(id);
  }
}
