import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientDto } from './dto/query-client.dto';
import { UploadsService } from '../uploads/uploads.service';
export declare class ClientsController {
    private readonly clientsService;
    private readonly uploadsService;
    constructor(clientsService: ClientsService, uploadsService: UploadsService);
    create(createClientDto: CreateClientDto): Promise<import("./entities/client.entity").Client>;
    findAll(query: QueryClientDto): Promise<import("../../common/utils/pagination.util").PaginationResult<import("./entities/client.entity").Client>>;
    findOne(id: string): Promise<import("./entities/client.entity").Client>;
    update(id: string, updateClientDto: UpdateClientDto): Promise<import("./entities/client.entity").Client>;
    remove(id: string): Promise<{
        message: string;
    }>;
    uploadLogo(id: string, file: Express.Multer.File): Promise<{
        logoUrl: string;
    }>;
}
