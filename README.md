# Startup XYZ: gestão de documentos para IA

Plataforma serverless na AWS para receber PDFs e imagens, isolar os arquivos por usuário e arquivar documentos com mais de 1 ano no S3 Glacier Deep Archive, sem apagar nada.

## Estrutura

```
frontend/                      Site estático (HTML, CSS e JS sem build), publicado no S3 + CloudFront
  index.html
  styles.css
  config.js                    Domínio e Client ID do Cognito (preencher)
  js/
    app.js                     Interface: login, upload, lista e abertura de documentos
    auth.js                    Login no Cognito com Authorization Code + PKCE
    api.js                     Chamadas à API em /api/*
    upload.js                  Upload direto no S3: PUT único ou multipart em paralelo
    format.js                  Formatação de tamanho e data
backend/
  lambdas/create-upload/       POST /api/uploads e POST /api/uploads/{docId}/complete
  lambdas/get-document-url/    GET /api/documents e GET /api/documents/{docId}
  policies/                    Bucket policy, CORS e policies IAM (com marcadores <...>)
docs/
  guia-backend-console.md      Passo a passo para criar tudo pelo console da AWS
```

## Como subir

Siga `docs/guia-backend-console.md`. O frontend só funciona publicado atrás do CloudFront, porque a API fica no mesmo domínio em `/api/*`.

## Free Tier e cobrança

### Como funciona o Free Tier hoje

Contas criadas a partir de 15 de julho de 2025 usam o modelo de créditos ([AWS Free Tier](https://aws.amazon.com/free/)):

- A conta nova recebe US$ 100 em créditos, e pode ganhar até mais US$ 100 completando atividades no console.
- **Free plan:** não gera cobrança. A conta fecha sozinha depois de 6 meses ou quando os créditos acabam, o que vier primeiro. Alguns serviços ficam bloqueados nesse plano.
- **Paid plan:** os créditos são usados primeiro. Depois disso, o uso é cobrado normalmente.
- Os créditos valem por até 12 meses a partir da criação da conta.
- Alguns serviços têm uma cota gratuita mensal permanente ("Always Free") nos dois planos. Quando o uso passa da cota, os créditos cobrem a diferença.

Contas criadas antes dessa data seguem o modelo antigo, com 12 meses de cotas gratuitas por serviço.

### O que este projeto usa e o que é gratuito

| Serviço | Cota gratuita | O que é cobrado além dela |
|---|---|---|
| AWS Lambda | Always Free: 1 milhão de requisições e 400 mil GB-segundos por mês | Requisições e duração acima da cota |
| Amazon Cognito | Always Free: 10 mil usuários ativos por mês (planos Lite e Essentials) | Usuários acima de 10 mil e plano Plus |
| Amazon CloudFront | Plano Free (flat-rate): 1 milhão de requisições, 100 GB de transferência, WAF com 5 regras e proteção DDoS, sem cobrança de excedente | Planos pagos a partir de US$ 15/mês, ou pay-as-you-go |
| AWS KMS | Always Free: 20 mil requisições por mês | **US$ 1/mês por chave**, sem cota gratuita. Requisições acima de 20 mil custam US$ 0,03 a cada 10 mil |
| Amazon CloudWatch | Always Free: 5 GB de logs e 10 alarmes por mês | Logs e alarmes acima da cota |
| AWS CloudTrail | Histórico de 90 dias e uma trail com eventos de gerenciamento | **Data events do S3: US$ 0,10 a cada 100 mil eventos** |
| Amazon API Gateway (REST) | Só no modelo antigo: 1 milhão de chamadas por mês nos 12 primeiros meses. Em contas novas, os créditos cobrem o uso | US$ 3,50 por milhão de chamadas (us-east-1) |
| Amazon S3 e Glacier Deep Archive | Sem cota permanente. Em contas novas, os créditos cobrem o uso | Armazenamento, requisições e transições do lifecycle |
| Amazon SNS | Volume de alertas por e-mail deste projeto custa centavos | Publicações e entregas |

Fontes: [Lambda](https://aws.amazon.com/lambda/pricing/), [KMS](https://aws.amazon.com/kms/pricing/), [CloudTrail](https://aws.amazon.com/cloudtrail/pricing/), [Free Tier](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html), [CloudFront flat-rate](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html). Valores consultados em novembro de 2026. Confirme na [AWS Pricing Calculator](https://calculator.aws/) antes de subir.

### Custo para testar (poucos usuários e arquivos)

Em uso de laboratório, quase tudo fica dentro das cotas gratuitas. O único custo fixo é a **chave do KMS, US$ 1/mês**. Com créditos do Free Tier, esse valor sai dos créditos.

### Custo estimado em produção

Premissa do case: 50 mil arquivos por mês, com 1 MB em média (cerca de 50 GB por mês), em us-east-1.

| Item | Estimativa |
|---|---|
| S3 Standard | ~US$ 14/mês ao fim do primeiro ano (~600 GB) |
| S3 PUT | ~US$ 0,25/mês (50 mil PUTs) |
| Glacier Deep Archive | ~US$ 0,60/mês para cada ano arquivado (~600 GB) |
| Transições do lifecycle | ~US$ 2,50/mês a partir do 13º mês (US$ 0,05 a cada mil objetos) |
| KMS | US$ 1/mês pela chave + requisições acima da cota |
| API Gateway REST + Lambda | Menos de US$ 2/mês nesse volume |
| Cognito | US$ 0 até 10 mil usuários ativos por mês |
| CloudFront | US$ 0 no plano Free, dentro dos limites do plano |
| WAF | Incluso no plano Free do CloudFront. No pay-as-you-go: ~US$ 5/mês por web ACL + US$ 1 por regra + requisições |
| CloudTrail data events | US$ 0,10 a cada 100 mil eventos |
| Alarmes do CloudWatch | US$ 0 até 10 alarmes |

### Cuidados com a cobrança

- **Crie um orçamento antes de começar.** No AWS Budgets, use o modelo *Zero spend budget* ou um orçamento mensal com alerta por e-mail.
- **O Free plan não mostra o lifecycle funcionando.** A conta fecha em até 6 meses, e a transição para o Deep Archive só acontece depois de 365 dias. Para ver a transição, use o Paid plan. Para testar antes disso, reduza temporariamente o prazo da regra para 1 dia.
- **Os documentos não podem ser apagados.** A bucket policy nega exclusões, então o armazenamento continua sendo cobrado mesmo que você pare de usar o projeto. Para desmontar o ambiente, siga a seção "Para desfazer" do guia.
- **O Deep Archive cobra no mínimo 180 dias** por objeto, e a restauração de um arquivo tem custo próprio.
- **Uploads multipart incompletos são cobrados** como armazenamento. A regra de lifecycle de 7 dias, descrita no guia, remove esses pedaços.
- **A transferência do S3 para a internet é cobrada acima de 100 GB por mês**, somando todos os serviços da conta. Os downloads por URL assinada vão direto do S3 para o navegador, sem passar pelo CloudFront, então não entram no plano Free do CloudFront.
