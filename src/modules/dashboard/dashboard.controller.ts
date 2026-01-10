import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { QueryDashboardDto } from './dto/query-dashboard.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Dashboard')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Retorna estatísticas gerais' })
  @ApiResponse({ status: 200, description: 'Estatísticas' })
  getStats() {
    return this.dashboardService.getStats();
  }

  @Get('recent')
  @ApiOperation({ summary: 'Retorna itens recentes para o dashboard' })
  @ApiResponse({ status: 200, description: 'Itens recentes' })
  getRecent(@Query() query: QueryDashboardDto) {
    return this.dashboardService.getRecent(query.limit);
  }
}
