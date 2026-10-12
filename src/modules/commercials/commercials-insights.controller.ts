import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminCostsQueryDto } from './dto/admin-costs.dto';
import { McEnabledGuard } from './mc-enabled.guard';
import { McAdminCostsService } from './services/mc-admin-costs.service';
import { McWindowPriceService } from './services/mc-window-price.service';

/**
 * Consultas DERIVADAS do módulo de comerciais, sem efeito sobre o pipeline
 * (change video-formatos-personagem): custo de fornecedor por mês (8.3,
 * admin) e avisos da janela do personagem sobre preços da arte (4.7, dono do
 * projeto). Mesmo prefixo, guards e envelope do `CommercialsController`; num
 * controller próprio para não acoplar estas leituras ao construtor dele.
 */
@ApiTags('commercials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, McEnabledGuard)
@Controller('commercials')
export class CommercialsInsightsController {
  constructor(
    private readonly configService: ConfigService,
    private readonly costs: McAdminCostsService,
    private readonly windowPrice: McWindowPriceService,
  ) {}

  /** Mesmo padrão das rotas admin do módulo (x-admin-token = ADMIN_API_TOKEN, ex.: admin/pause). */
  private assertAdminToken(token: string | undefined): void {
    const expected = this.configService.get<string>('ADMIN_API_TOKEN');
    if (!expected) {
      throw new ForbiddenException('ADMIN_API_TOKEN não configurado no servidor.');
    }
    if (!token || token !== expected) {
      throw new ForbiddenException('Token administrativo inválido.');
    }
  }

  /**
   * Custo de fornecedor (US$) no mês — por projeto, por motor e por tier, com
   * totais — a partir do custo gravado em cada clipe pelo ingest. `month`
   * `YYYY-MM` (UTC); ausente = mês corrente.
   */
  @Get('admin/costs')
  @ApiOperation({ summary: '[Admin] Custo de fornecedor dos comerciais no mês' })
  adminCosts(
    @Headers('x-admin-token') adminToken: string | undefined,
    @Query() query: AdminCostsQueryDto,
  ) {
    this.assertAdminToken(adminToken);
    return this.costs.monthlyCosts(query.month);
  }

  /**
   * Avisos da janela do personagem na arte que fala (spec "Janela sobre
   * preço"): `{warnings: [{code: 'WINDOW_COVERS_PRICE', box, ...}]}`. Nunca
   * bloqueia; detecção indisponível → avisos vazios + `error`.
   */
  @Get('projects/:id/window-warnings')
  windowWarnings(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.windowPrice.checkOwned(user.id, id);
  }
}
