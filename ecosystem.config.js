module.exports = {
  apps: [
    {
      name: 'flyer-api',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      node_args: '--max-old-space-size=2048',
    },
    {
      // Worker de mídia (TDD ADR-02): mesmo codebase, processo separado, sem HTTP.
      // Consome as filas pg-boss (ai.generate/ai.poll, render.export e as futuras mc.*).
      // Sem ele, toda task criada em produção fica em `queued` para sempre.
      name: 'flyer-media-worker',
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        WORKER_ONLY: 'true',
        RENDER_CONCURRENCY: '1',
        UV_THREADPOOL_SIZE: '4',
      },
      error_file: './logs/pm2-worker-error.log',
      out_file: './logs/pm2-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1200M', // pico/leak de ffmpeg ⇒ restart limpo
      kill_timeout: 30000, // tempo para o pg-boss drenar o job em andamento
    },
  ],
};
