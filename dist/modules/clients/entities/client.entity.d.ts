import { ClientContact } from './client-contact.entity';
export declare class Client {
    id: string;
    name: string;
    cnpj: string;
    logoUrl: string | null;
    contacts: ClientContact[];
    createdAt: Date;
    updatedAt: Date;
}
