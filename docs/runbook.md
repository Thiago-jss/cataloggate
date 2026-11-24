# Runbook — operação local

Não execute comandos de parada em outro projeto Compose. A stack comum é `cataloggate`; os testes de interrupção usam `cataloggate-qa` ou `cataloggate-ci`. Nos exemplos de API, use as chaves locais geradas, sem imprimi-las em logs ou relatórios.

| Sintoma                                 | Diagnóstico                                                                   | Ação                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending` com `outboxBacklog` crescendo | O publicador ainda não conseguiu confirmar as mensagens.                      | Verifique o RabbitMQ e os logs JSON da API. A outbox publica as pendências quando houver confirmação. Não reenvie o lote para cobrir a indisponibilidade.                           |
| `pending` sem backlog correspondente    | O evento pode estar no broker ou em processamento.                            | Confira estado do worker e `GET /imports/:id/attempts` com a credencial de revisor.                                                                                                 |
| `failed`                                | O worker esgotou as tentativas daquela entrega e persistiu uma falha técnica. | Corrija a dependência, confirme a `generation` atual com `GET /imports/:id` e envie `POST /imports/:id/retry` com `{"expectedGeneration": n}`. Confira a nova geração no histórico. |
| `completed` com rejeições               | O pipeline funcionou e encontrou erros de catálogo.                           | Corrija o JSON e envie um novo lote, com nova chave de idempotência. Reprocessar o original não resolve a regra de negócio.                                                         |
| `STALE_PREVIEW`                         | Outro lote já avançou a versão do catálogo.                                   | Consulte a prévia novamente e revise as diferenças antes de decidir. Não reenvie a aprovação reciclando apenas o número.                                                            |
| Redis sem resposta                      | Leituras usam as fontes duráveis, possivelmente com maior latência.           | Confira o Redis sem alterar o estado dos lotes.                                                                                                                                     |

`GET /health` confirma que o processo HTTP responde. `GET /ops/metrics` mostra lotes pendentes, falhos e concluídos, backlog da outbox, tentativas e tempo médio entre envio e conclusão. Os indicadores são cumulativos e restritos ao fornecedor da credencial. A API de métricas é JSON; não há Prometheus, alertas ou instrumentação de infra instalados.

## Atualização local com dados

Depois de fazer backup, pare a API e o worker antes de atualizar a imagem e rodar o Compose, para não misturar workers antigos com mensagens que possuem geração. As migrações são incrementais. A versão atual aceita mensagens antigas sem geração como geração `1`; a geração esperada impede que essas mensagens afetem uma recuperação posterior. Não remova volumes para atualizar credenciais ou schema.
