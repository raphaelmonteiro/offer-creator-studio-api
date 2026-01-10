import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Client } from './entities/client.entity';
import { ClientContact } from './entities/client-contact.entity';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientDto } from './dto/query-client.dto';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private clientRepository: Repository<Client>,
    @InjectRepository(ClientContact)
    private contactRepository: Repository<ClientContact>,
  ) {}

  async create(createClientDto: CreateClientDto): Promise<Client> {
    const existingClient = await this.clientRepository.findOne({
      where: { cnpj: createClientDto.cnpj },
    });

    if (existingClient) {
      throw new ConflictException({
        code: 'CNPJ_ALREADY_EXISTS',
        message: 'CNPJ já cadastrado',
      });
    }

    const client = this.clientRepository.create({
      name: createClientDto.name,
      cnpj: createClientDto.cnpj,
      logoUrl: createClientDto.logoUrl || null,
    });

    const savedClient = await this.clientRepository.save(client);

    if (createClientDto.contacts && createClientDto.contacts.length > 0) {
      const contacts = createClientDto.contacts.map((contactDto) =>
        this.contactRepository.create({
          ...contactDto,
          clientId: savedClient.id,
        }),
      );
      await this.contactRepository.save(contacts);
    }

    return this.findOne(savedClient.id);
  }

  async findAll(query: QueryClientDto): Promise<PaginationResult<Client>> {
    const { page = 1, limit = 20, search } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.name = Like(`%${search}%`);
      // Also search by CNPJ
    }

    const queryBuilder = this.clientRepository.createQueryBuilder('client')
      .leftJoinAndSelect('client.contacts', 'contacts');

    if (search) {
      queryBuilder.where(
        '(client.name LIKE :search OR client.cnpj LIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder.skip(skip).take(limit).orderBy('client.createdAt', 'DESC');

    const [clients, total] = await queryBuilder.getManyAndCount();

    return paginate(clients, total, { page, limit });
  }

  async findOne(id: string): Promise<Client> {
    const client = await this.clientRepository.findOne({
      where: { id },
      relations: ['contacts'],
    });

    if (!client) {
      throw new NotFoundException({
        code: 'CLIENT_NOT_FOUND',
        message: 'Cliente não encontrado',
      });
    }

    return client;
  }

  async update(id: string, updateClientDto: UpdateClientDto): Promise<Client> {
    const client = await this.findOne(id);

    if (updateClientDto.cnpj && updateClientDto.cnpj !== client.cnpj) {
      const existingClient = await this.clientRepository.findOne({
        where: { cnpj: updateClientDto.cnpj },
      });

      if (existingClient) {
        throw new ConflictException({
          code: 'CNPJ_ALREADY_EXISTS',
          message: 'CNPJ já cadastrado',
        });
      }
    }

    if (updateClientDto.name) {
      client.name = updateClientDto.name;
    }

    if (updateClientDto.cnpj) {
      client.cnpj = updateClientDto.cnpj;
    }

    if (updateClientDto.logoUrl !== undefined) {
      client.logoUrl = updateClientDto.logoUrl;
    }

    await this.clientRepository.save(client);

    // Update contacts
    if (updateClientDto.contacts) {
      // Remove existing contacts
      await this.contactRepository.delete({ clientId: id });

      // Create new contacts
      if (updateClientDto.contacts.length > 0) {
        const contacts = updateClientDto.contacts.map((contactDto) =>
          this.contactRepository.create({
            ...contactDto,
            clientId: id,
          }),
        );
        await this.contactRepository.save(contacts);
      }
    }

    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const client = await this.findOne(id);
    await this.clientRepository.remove(client);
  }

  async updateLogo(id: string, logoUrl: string): Promise<Client> {
    const client = await this.findOne(id);
    client.logoUrl = logoUrl;
    return this.clientRepository.save(client);
  }
}
