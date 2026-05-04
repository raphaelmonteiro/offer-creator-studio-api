import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { FlyerBuilderV2Service } from './flyer-builder-v2.service';
import { CreateFlyerBuilderV2DocumentDto } from './dto/create-flyer-builder-v2-document.dto';
import { UpdateFlyerBuilderV2DocumentDto } from './dto/update-flyer-builder-v2-document.dto';
import { QueryFlyerBuilderV2DocumentDto } from './dto/query-flyer-builder-v2-document.dto';

@ApiTags('Flyer Builder V2')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-builder-v2')
export class FlyerBuilderV2Controller {
  constructor(private readonly flyerBuilderV2Service: FlyerBuilderV2Service) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria um documento do Flyer Builder V2' })
  @ApiResponse({ status: 201, description: 'Documento V2 criado com sucesso' })
  create(@Body() dto: CreateFlyerBuilderV2DocumentDto) {
    return this.flyerBuilderV2Service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista documentos do Flyer Builder V2' })
  @ApiResponse({ status: 200, description: 'Lista de documentos V2' })
  findAll(@Query() query: QueryFlyerBuilderV2DocumentDto) {
    return this.flyerBuilderV2Service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um documento do Flyer Builder V2' })
  @ApiResponse({ status: 200, description: 'Documento V2 encontrado' })
  findOne(@Param('id') id: string) {
    return this.flyerBuilderV2Service.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um documento do Flyer Builder V2' })
  @ApiResponse({ status: 200, description: 'Documento V2 atualizado' })
  update(@Param('id') id: string, @Body() dto: UpdateFlyerBuilderV2DocumentDto) {
    return this.flyerBuilderV2Service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove um documento do Flyer Builder V2' })
  @ApiResponse({ status: 200, description: 'Documento V2 removido' })
  remove(@Param('id') id: string) {
    return this.flyerBuilderV2Service.remove(id).then(() => ({
      message: 'Documento V2 removido com sucesso',
    }));
  }
}

