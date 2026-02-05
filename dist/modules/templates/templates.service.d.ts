import { Repository } from 'typeorm';
import { Template } from './entities/template.entity';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { PaginationResult } from '../../common/utils/pagination.util';
export declare class TemplatesService {
    private templateRepository;
    constructor(templateRepository: Repository<Template>);
    create(createTemplateDto: CreateTemplateDto): Promise<Template>;
    findAll(query: QueryTemplateDto): Promise<PaginationResult<Template>>;
    findOne(id: string): Promise<Template>;
    update(id: string, updateTemplateDto: UpdateTemplateDto): Promise<Template>;
    remove(id: string): Promise<void>;
    updateThumbnail(id: string, thumbnailUrl: string): Promise<Template>;
}
