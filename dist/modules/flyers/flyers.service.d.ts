import { Repository } from 'typeorm';
import { Flyer } from './entities/flyer.entity';
import { CreateFlyerDto } from './dto/create-flyer.dto';
import { UpdateFlyerDto } from './dto/update-flyer.dto';
import { QueryFlyerDto } from './dto/query-flyer.dto';
import { DuplicateFlyerDto } from './dto/duplicate-flyer.dto';
import { PaginationResult } from '../../common/utils/pagination.util';
export declare class FlyersService {
    private flyerRepository;
    constructor(flyerRepository: Repository<Flyer>);
    create(createFlyerDto: CreateFlyerDto): Promise<Flyer>;
    findAll(query: QueryFlyerDto): Promise<PaginationResult<Flyer>>;
    findOne(id: string): Promise<any>;
    update(id: string, updateFlyerDto: UpdateFlyerDto): Promise<Flyer>;
    remove(id: string): Promise<void>;
    duplicate(id: string, duplicateDto: DuplicateFlyerDto): Promise<Flyer>;
    updateThumbnail(id: string, thumbnailUrl: string): Promise<Flyer>;
    export(id: string, format: string, quality: string): Promise<{
        downloadUrl: string;
        expiresAt: Date;
    }>;
}
