import { ClientContactDto } from './client-contact.dto';
export declare class CreateClientDto {
    name: string;
    cnpj: string;
    logoUrl?: string | null;
    contacts?: ClientContactDto[];
}
