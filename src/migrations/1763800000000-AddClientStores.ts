import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lojas por cliente: cria a tabela `client_stores` (uma rede pode ter várias lojas, cada uma com
 * endereço/CNPJ/telefone/e-mail/horário próprios). OneToMany a partir de `clients`, com FK em
 * cascade (apagar o cliente apaga as lojas). Nada é apagado do modelo atual — os campos de
 * endereço/telefone no próprio cliente continuam existindo (viram legado/opcional).
 */
export class AddClientStores1763800000000 implements MigrationInterface {
  name = 'AddClientStores1763800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "client_stores" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "cnpj" varchar,
        "address" varchar,
        "phoneFixed" varchar,
        "phoneMobile" varchar,
        "email" varchar,
        "hours" varchar,
        "clientId" uuid NOT NULL,
        CONSTRAINT "PK_client_stores" PRIMARY KEY ("id"),
        CONSTRAINT "FK_client_stores_client" FOREIGN KEY ("clientId")
          REFERENCES "clients" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_client_stores_clientId" ON "client_stores" ("clientId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_stores_clientId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_stores"`);
  }
}
