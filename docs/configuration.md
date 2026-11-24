# Configuração e privilégios

`node scripts/bootstrap.mjs` provisiona o `.env` local com valores aleatórios independentes, não os imprime e não sobrescreve um arquivo existente. `.env.example` é só o contrato. O Git ignora os arquivos gerados e o Docker não os copia para a imagem. O Compose recusa variáveis obrigatórias ausentes. O runner de CI gera e descarta a própria configuração. Se já tiver um `.env` da primeira etapa de hardening, `node scripts/bootstrap.mjs --extend` acrescenta as chaves de demo que faltam sem substituir os valores existentes.

- Identidades de demo: quatro chaves de alta entropia, uma por função e fornecedor. O PostgreSQL armazena apenas o resumo SHA-256; API e worker não recebem as chaves brutas. Use as chaves locais com `Authorization: Bearer ...`.
- PostgreSQL: o processo de migração usa a conta de administração do ambiente local. API e worker usam `cataloggate_app`, sem criação de tabelas nem acesso à trilha interna de migrações.
- MongoDB: a entrada de dados é reservada ao worker. A API usa uma conta com `find` na coleção de auditoria. Nenhum dos dois recebe as credenciais de administração.
- RabbitMQ: namespace próprio de vhost; o broker não publica AMQP nem interface administrativa para o host. Redis exige autenticação e não publica porta.

Configuração local via ambiente **não é um cofre**. Quem administra o host ou o daemon Docker pode inspecioná-la. Não compartilhe o `.env`, a saída completa de `docker compose config` nem dumps de ambiente. Um deploy real deve buscar segredos em um mecanismo gerenciado, usar TLS quando houver tráfego fora da rede privada e ter procedimentos de rotação e backup.

## Upgrade e rotação

Os volumes da primeira demo usavam identidades diferentes. A stack atual usa novos nomes para PostgreSQL, MongoDB e RabbitMQ e não apaga nem tenta reutilizar os volumes legados. Para preservar dados antigos, faça backup antes da troca e migre por restauração controlada. A demo pode iniciar vazia; nenhuma remoção é necessária. Alterar `.env` não faz os entrypoints dos serviços atualizarem usuários em volumes já inicializados. Quando manter os dados, faça a rotação no serviço e atualize o `.env` de forma coordenada. Use `down --volumes` somente para descartar dados deliberadamente no projeto correto.
