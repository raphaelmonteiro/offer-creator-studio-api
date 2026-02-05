import { Repository } from 'typeorm';
import { Client } from './entities/client.entity';
import { ClientContact } from './entities/client-contact.entity';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientDto } from './dto/query-client.dto';
import { PaginationResult } from '../../common/utils/pagination.util';
export declare class ClientsService {
    private clientRepository;
    private contactRepository;
    constructor(clientRepository: Repository<Client>, contactRepository: Repository<ClientContact>);
    create(createClientDto: CreateClientDto): Promise<Client>;
    findAll(query: QueryClientDto): Promise<PaginationResult<Client>>;
    findOne(id: string): Promise<Client>;
    update(id: string, updateClientDto: UpdateClientDto): Promise<Client>;
    remove(id: string): Promise<void>;
    updateLogo(id: string, logoUrl: string): Promise<Client>;
}
