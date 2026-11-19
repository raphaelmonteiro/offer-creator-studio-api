import './e2e-cli-describe-stub';
import { runFlyerProCaseCommand } from './e2e-flyer-pro-case-command';

/**
 * `npm run --silent e2e:flyer-pro-case -- create|purge ...`: cria ou apaga os encartes dos casos do e2e de navegador no
 * banco de `FLYER_PRO_E2E_DB_URL`. Veja `runFlyerProCaseCommand`. A saída é uma linha JSON (a última do stdout).
 */
runFlyerProCaseCommand(process.argv.slice(2))
  .then((result) => {
    console.log(JSON.stringify(result));
  })
  .catch((error: Error) => {
    console.error(`e2e:flyer-pro-case falhou: ${error.message}`);
    process.exit(1);
  });
