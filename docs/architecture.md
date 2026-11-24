# Decisões de arquitetura

## Fronteiras

O CatalogGate implementa uma capacidade: auditar um lote que ainda não foi publicado na loja. A API e o worker compartilham código e persistência, mas são processos separados. O consumidor não depende do servidor HTTP estar no ar. O publicador da outbox roda junto com a API e volta a ler as pendências quando o processo reinicia.

```text
src/
  imports/
    domain/           Normalização, validação e deduplicação de SKUs
    application/      Casos de uso e contratos que eles consomem
    http/             Validação de entrada, rotas e tradução de erros
    infrastructure/   Adaptadores PostgreSQL, MongoDB, RabbitMQ e Redis
    imports.module.ts Composição dos processos NestJS
  platform/           Configuração, conexões e migrações
```

Os contratos de leitura, submissão e execução são separados: ler um relatório não exige acesso a métodos de gravação. Interface separada é útil nesse ponto porque protege as dependências tecnológicas; não há repositório genérico, barramento interno nem classes para regras que cabem em funções puras. Cada formato tem um extrator e compartilha as mesmas regras de auditoria.

## O que acontece em uma importação

1. O HTTP valida JSON, profundidade, tamanho e chave idempotente. O formato do fornecedor é consultado no banco e registrado no lote; o cliente não escolhe como os dados serão interpretados.
2. Uma transação grava o lote e a outbox no PostgreSQL. O original fica no lote como buffer de entrada. A API só devolve `202` após o commit. A identidade é `(fornecedor, chave)`; um hash do JSON canônico ignora a ordem das chaves de objetos, mas preserva a ordem das linhas. Mesma chave com conteúdo diferente dá `409`.
3. O publicador busca eventos pendentes e envia `{ importId }` no RabbitMQ. Só atualiza `sent_at` depois de uma confirmação positiva e roteável. As filas são duráveis e as mensagens de trabalho, persistentes. Não há transação distribuída entre banco e broker.
4. O worker interpreta o lote e faz um upsert imutável no MongoDB, com `_id` igual ao protocolo. O documento guarda o JSON original como texto e tem resultados estruturados (linhas aceitas e motivos de rejeição). Não há uso de campos externos como operadores ou chaves de consulta. O PostgreSQL passa para `completed`, grava os totais e libera o buffer somente depois da gravação no MongoDB. O relatório fica visível só depois dessa transição.
5. A consulta confirma o estado no PostgreSQL, depois usa Redis como cache-aside do relatório consolidado. Resultados concluídos não mudam nesta versão; uma correção é um novo lote. Isso dispensa invalidar relatórios existentes a cada envio.

## Janelas de falha

| Falha                                                                           | Comportamento                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker indisponível após a aceitação                                            | O evento fica pendente no PostgreSQL. O publicador tenta novamente sem bloquear requisições HTTP.                                                                                                                                    |
| Publicação confirmada, mas o banco não registra o envio                         | O mesmo identificador pode ser publicado de novo.                                                                                                                                                                                    |
| Worker fecha a conexão após gravar no MongoDB, antes de finalizar no PostgreSQL | A auditoria existente é reutilizada; a nova tentativa conclui o estado e os totais.                                                                                                                                                  |
| Worker termina de gravar, mas não confirma a entrega                            | Uma nova entrega não muda o lote já concluído e é confirmada.                                                                                                                                                                        |
| Mensagem inválida ou falhas de processamento esgotadas                          | Mensagens inválidas vão para a fila de descarte. Após três tentativas por entrega, o worker tenta registrar `failed` e encaminhar a mensagem à mesma fila. Se não consegue persistir o estado, ele solicita reentrega com uma pausa. |
| Redis indisponível                                                              | Leitura pelo PostgreSQL e MongoDB; o cache tem tempo de espera curto e não é autoridade.                                                                                                                                             |

Garantia intencional: **entrega pelo menos uma vez sob as falhas recuperáveis exercitadas, com efeito idempotente**. Não há promessa de entrega exatamente uma vez, FIFO de negócio, ou recuperação após perda física dos volumes. A composição padrão executa um publicador e um consumidor. Não faz eleição de líder nem pretende demonstrar alta disponibilidade de broker ou bancos.

## Escopo local

- Apenas dois fornecedores fictícios e lotes JSON de 1 a 500 itens, limitados a 128 KiB e 20 níveis de aninhamento nos itens.
- SKU é normalizado para maiúsculas; todas as linhas com o mesmo SKU válido são rejeitadas, inclusive quando uma delas também falha por outro motivo. Estoque deve ser um inteiro seguro não negativo, sem coerção.
- Não publica estoque em outra plataforma. Não há frontend, autenticação, retenção automática, painel para redrive nem operação multi-tenant. A falha terminal exige análise do operador e uma nova submissão com outra chave.
- As credenciais locais são geradas por instalação, sem portas públicas nos bancos, cache ou broker. Não use dados reais. Um rollout público exigiria autenticação, autorização, gestão de segredos, limites por cliente e uma política de retenção.
- A migração versionada é aplicada por um processo único no startup do Compose. A stack de testes usa dados isolados; não se executa interrupção de dependências em serviços compartilhados.
