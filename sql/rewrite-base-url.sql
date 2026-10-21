-- Troca o prefixo das URLs gravadas no banco (uploads, thumbnails, logos, avatares,
-- URLs dentro de JSONB como flyer.configuration) quando o host da aplicação muda —
-- por exemplo de http://34.138.240.137 para https://encarte.seudominio.com.br.
--
-- Varre TODAS as colunas text/varchar/json/jsonb das tabelas do schema public e
-- substitui o texto :old por :new onde ele aparecer. Por padrão só RELATA (dry=1).
--
-- Relatório (não altera nada):
--   psql -h localhost -U <user> -d <db> -v old="http://34.138.240.137" -v new="https://encarte.exemplo.com" -f sql/rewrite-base-url.sql
--
-- Aplicar (tudo numa transação; faça backup antes: pg_dump -Fc <db> > antes.dump):
--   psql ... -v old="http://34.138.240.137" -v new="https://encarte.exemplo.com" -v dry=0 -f sql/rewrite-base-url.sql
--
-- Depois: pm2 restart flyer-api (não é obrigatório, mas limpa caches em memória).

\set ON_ERROR_STOP on
\if :{?dry}
\else
  \set dry 1
\endif
\if :{?old}
\else
  \set old ''
\endif
\if :{?new}
\else
  \set new ''
\endif

BEGIN;

SELECT set_config('app.old', :'old', true) AS _old,
       set_config('app.new', :'new', true) AS _new,
       set_config('app.dry', :'dry', true) AS _dry
\gset

DO $$
DECLARE
  v_old   text := current_setting('app.old');
  v_new   text := current_setting('app.new');
  v_dry   boolean := current_setting('app.dry') <> '0';
  r       record;
  n       bigint;
  total   bigint := 0;
BEGIN
  IF v_old = '' OR v_new = '' THEN
    RAISE EXCEPTION 'Informe -v old="http://IP" e -v new="https://dominio"';
  END IF;
  IF v_old = v_new THEN
    RAISE EXCEPTION 'old e new são iguais';
  END IF;

  RAISE NOTICE '% % → %', CASE WHEN v_dry THEN '[RELATÓRIO]' ELSE '[APLICANDO]' END, v_old, v_new;

  FOR r IN
    SELECT c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.is_generated = 'NEVER'
       AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')
     ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text LIKE %L',
                   r.table_name, r.column_name, '%' || v_old || '%')
       INTO n;
    CONTINUE WHEN n = 0;

    total := total + n;
    RAISE NOTICE '  %.% (%): % linha(s)', r.table_name, r.column_name, r.data_type, n;

    IF NOT v_dry THEN
      IF r.data_type IN ('json', 'jsonb') THEN
        EXECUTE format('UPDATE %I SET %I = replace(%I::text, %L, %L)::%s WHERE %I::text LIKE %L',
                       r.table_name, r.column_name, r.column_name, v_old, v_new, r.data_type,
                       r.column_name, '%' || v_old || '%');
      ELSE
        EXECUTE format('UPDATE %I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
                       r.table_name, r.column_name, r.column_name, v_old, v_new,
                       r.column_name, '%' || v_old || '%');
      END IF;
    END IF;
  END LOOP;

  IF v_dry THEN
    RAISE NOTICE 'Total: % linha(s) seriam alteradas. Rode com -v dry=0 para aplicar.', total;
  ELSE
    RAISE NOTICE 'Total: % linha(s) alteradas.', total;
  END IF;
END $$;

COMMIT;
