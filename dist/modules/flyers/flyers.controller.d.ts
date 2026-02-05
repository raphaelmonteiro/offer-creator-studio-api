import { FlyersService } from './flyers.service';
import { CreateFlyerDto } from './dto/create-flyer.dto';
import { UpdateFlyerDto } from './dto/update-flyer.dto';
import { QueryFlyerDto } from './dto/query-flyer.dto';
import { DuplicateFlyerDto } from './dto/duplicate-flyer.dto';
import { UploadsService } from '../uploads/uploads.service';
export declare class FlyersController {
    private readonly flyersService;
    private readonly uploadsService;
    constructor(flyersService: FlyersService, uploadsService: UploadsService);
    create(createFlyerDto: CreateFlyerDto): Promise<import("./entities/flyer.entity").Flyer>;
    findAll(query: QueryFlyerDto): Promise<import("../../common/utils/pagination.util").PaginationResult<import("./entities/flyer.entity").Flyer>>;
    findOne(id: string): Promise<any>;
    update(id: string, updateFlyerDto: UpdateFlyerDto): Promise<import("./entities/flyer.entity").Flyer>;
    remove(id: string): Promise<{
        message: string;
    }>;
    duplicate(id: string, duplicateDto: DuplicateFlyerDto): Promise<import("./entities/flyer.entity").Flyer>;
    uploadThumbnail(id: string, file: Express.Multer.File): Promise<{
        thumbnailUrl: string;
    }>;
    export(id: string, format?: string, quality?: string): Promise<{
        downloadUrl: string;
        expiresAt: Date;
    }>;
}
