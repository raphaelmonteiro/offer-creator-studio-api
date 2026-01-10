import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { CollaboratorsService } from './collaborators.service';
import { CreateCollaboratorDto } from './dto/create-collaborator.dto';
import { UpdateCollaboratorDto } from './dto/update-collaborator.dto';
import { QueryCollaboratorDto } from './dto/query-collaborator.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { SkipValidation } from '../../common/decorators/skip-validation.decorator';

@ApiTags('Collaborators')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('collaborators')
export class CollaboratorsController {
  constructor(
    private readonly collaboratorsService: CollaboratorsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cria um novo colaborador' })
  @ApiResponse({ status: 201, description: 'Colaborador criado com sucesso' })
  create(@Body() createCollaboratorDto: CreateCollaboratorDto) {
    return this.collaboratorsService.create(createCollaboratorDto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos os colaboradores' })
  @ApiResponse({ status: 200, description: 'Lista de colaboradores' })
  findAll(@Query() query: QueryCollaboratorDto) {
    return this.collaboratorsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um colaborador específico' })
  @ApiResponse({ status: 200, description: 'Colaborador encontrado' })
  @ApiResponse({ status: 404, description: 'Colaborador não encontrado' })
  findOne(@Param('id') id: string) {
    return this.collaboratorsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza um colaborador' })
  @ApiResponse({ status: 200, description: 'Colaborador atualizado' })
  update(
    @Param('id') id: string,
    @Body() updateCollaboratorDto: UpdateCollaboratorDto,
  ) {
    return this.collaboratorsService.update(id, updateCollaboratorDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove um colaborador' })
  @ApiResponse({ status: 200, description: 'Colaborador removido' })
  remove(@Param('id') id: string) {
    return this.collaboratorsService.remove(id).then(() => ({
      message: 'Colaborador removido com sucesso',
    }));
  }

  @Post(':id/avatar')
  @SkipValidation()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload do avatar do colaborador' })
  @ApiResponse({ status: 200, description: 'Avatar enviado com sucesso' })
  async uploadAvatar(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const upload = await this.uploadsService.uploadFile(file, 'avatars');
    const collaborator = await this.collaboratorsService.updateAvatar(id, upload.url);
    return { avatarUrl: collaborator.avatarUrl };
  }
}
