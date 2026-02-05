import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { UploadsService } from '../uploads/uploads.service';
export declare class TemplatesController {
    private readonly templatesService;
    private readonly uploadsService;
    constructor(templatesService: TemplatesService, uploadsService: UploadsService);
    create(createTemplateDto: CreateTemplateDto): Promise<import("./entities/template.entity").Template>;
    findAll(query: QueryTemplateDto): Promise<import("../../common/utils/pagination.util").PaginationResult<import("./entities/template.entity").Template>>;
    findOne(id: string): Promise<import("./entities/template.entity").Template>;
    update(id: string, updateTemplateDto: UpdateTemplateDto): Promise<import("./entities/template.entity").Template>;
    remove(id: string): Promise<{
        message: string;
    }>;
    uploadThumbnail(id: string, file: Express.Multer.File): Promise<{
        thumbnailUrl: string;
    }>;
}
