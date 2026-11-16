import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ListFlyerProTemplatesQueryDto } from '../dto/list-flyer-pro-templates-query.dto';
import { FlyerProTemplatesService } from '../services/flyer-pro-templates.service';

@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/templates')
export class FlyerProTemplatesController {
  constructor(private readonly templates: FlyerProTemplatesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista os templates do Encarte Pro: uma entrada por cena do Templates v2 (27x40 e 54x40)',
  })
  @ApiResponse({ status: 200, description: 'Entradas com faces, zonas, faixas e camadas' })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: consulta fora da forma' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  list(@Query() query: ListFlyerProTemplatesQueryDto) {
    return this.templates.list(query);
  }
}
