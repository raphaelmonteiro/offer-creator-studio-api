import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateSceneDto } from './dto/create-scene.dto';
import { GetSceneQueryDto, ListScenesQueryDto } from './dto/list-scenes-query.dto';
import { sceneNotFound } from './scene.errors';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

/** Id que não é UUID também é "cena não encontrada" (sem revelar nada além disso). */
export const SceneIdPipe = new ParseUUIDPipe({ exceptionFactory: () => sceneNotFound() });

@ApiTags('template-scenes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TemplateSceneEnabledGuard)
@Controller('template-scenes')
export class TemplateScenesController {
  constructor(private readonly scenes: TemplateScenesService) {}

  @Post()
  @ApiOperation({ summary: 'Cria uma cena num formato de impressão' })
  create(@Body() dto: CreateSceneDto, @CurrentUser() user: { id: string }) {
    return this.scenes.create(dto, user?.id ?? null);
  }

  @Get()
  @ApiOperation({ summary: 'Lista as cenas de todos os usuários (leve, paginada)' })
  list(@Query() query: ListScenesQueryDto) {
    return this.scenes.list(query.page, query.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Abre a cena: versão atual, zonas, mensagens e versões' })
  get(@Param('id', SceneIdPipe) id: string, @Query() query: GetSceneQueryDto) {
    return this.scenes.get(id, query.versionsPage);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui (logicamente) a cena e cancela a versão em curso' })
  async remove(@Param('id', SceneIdPipe) id: string): Promise<void> {
    await this.scenes.remove(id);
  }
}
