import { Client } from './client.entity';
export declare class ClientContact {
    id: string;
    name: string;
    role: string;
    email: string;
    phone: string;
    clientId: string;
    client: Client;
}
