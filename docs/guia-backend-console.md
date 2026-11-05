# Guia: criando o backend da Startup XYZ pelo console da AWS

Este guia monta, na ordem, tudo que o frontend precisa. Os nomes dos botões estão em inglês, como aparecem no console com idioma em inglês.

Escolha uma região (ex.: `us-east-1` ou `sa-east-1`) e use sempre a mesma. CloudFront e IAM são globais. S3, KMS, Lambda, API Gateway e Cognito são regionais e precisam ficar todos na região escolhida.

## Arquivos usados

| Arquivo | Para que serve |
|---|---|
| `backend/lambdas/create-upload/index.mjs` | Código da Lambda `xyz-create-upload` |
| `backend/lambdas/get-document-url/index.mjs` | Código da Lambda `xyz-get-document-url` |
| `backend/policies/documents-bucket-policy.json` | Bucket policy do bucket de documentos |
| `backend/policies/documents-bucket-cors.json` | CORS do bucket de documentos |
| `backend/policies/lambda-assume-access-role.json` | Inline policy das duas roles das Lambdas |
| `backend/policies/access-role-trust-policy.json` | Trust policy da role de acesso aos documentos |
| `backend/policies/access-role-permissions.json` | Permissões da role de acesso aos documentos |
| `frontend/` | Site estático que vai para o bucket do site |

## Valores para anotar

Os JSON têm marcadores entre `< >`. Anote os valores abaixo conforme for criando e substitua nos arquivos antes de colar no console.

| Marcador | Onde você descobre | Exemplo |
|---|---|---|
| `<ACCOUNT_ID>` | Menu da conta, no canto superior direito do console | `111122223333` |
| `<REGIAO>` | Seletor de região | `us-east-1` |
| `<BUCKET_DOCUMENTOS>` | Passo 2 | `xyz-documents-111122223333` |
| `<KMS_KEY_ARN>` | Passo 1 | `arn:aws:kms:us-east-1:111122223333:key/1234abcd-...` |
| `<DOMINIO_CLOUDFRONT>` | Passo 5 | `d111111abcdef8.cloudfront.net` |
| Domínio do Cognito | Passo 6 | `https://us-east-1abc123.auth.us-east-1.amazoncognito.com` |
| Client ID do Cognito | Passo 6 | `1h57kf5cpq17m0eml12EXAMPLE` |
| Invoke URL da API | Passo 7 | `https://abc123.execute-api.us-east-1.amazonaws.com/prod` |

---

## Passo 1. Chave de criptografia (KMS)

1. Abra **KMS** → **Customer managed keys** → **Create key**.
2. **Key type:** Symmetric. **Key usage:** Encrypt and decrypt. **Next**.
3. **Alias:** `xyz-documents`. **Next**.
4. **Key administrators:** marque o seu usuário ou role de admin. **Next**.
5. **Key users:** deixe em branco. As permissões de uso vêm da policy IAM do passo 3. **Next** → **Finish**.
6. Abra a chave e copie o **ARN**. Esse é o `<KMS_KEY_ARN>`.

Custo: US$ 1 por mês pela chave, mais as requisições. O S3 Bucket Key (passo 2) reduz as chamadas ao KMS.

## Passo 2. Bucket de documentos (S3)

### 2.1 Criar o bucket

1. Abra **S3** → **Create bucket** → **General purpose**.
2. **Bucket name:** um nome único, ex.: `xyz-documents-<ACCOUNT_ID>`. Esse é o `<BUCKET_DOCUMENTOS>`.
3. **Object Ownership:** ACLs disabled (Bucket owner enforced).
4. **Block Public Access:** deixe **Block all public access** marcado.
5. **Bucket Versioning:** Enable.
6. **Default encryption:** SSE-KMS → **Choose from your AWS KMS keys** → `xyz-documents`. **Bucket Key:** Enable.
7. **Object Lock:** deixe desabilitado. O motivo está no fim do guia, em "Decisões".
8. **Create bucket**.

### 2.2 Bucket policy (TLS obrigatório e proibição de exclusão)

1. Abra `backend/policies/documents-bucket-policy.json` e troque `<BUCKET_DOCUMENTOS>` pelo nome do bucket.
2. No bucket: **Permissions** → **Bucket policy** → **Edit** → cole o JSON → **Save changes**.

> **Atenção:** depois disso ninguém consegue apagar objetos nem o bucket, inclusive você. Para apagar algo no futuro, alguém com permissão de admin precisa remover essa policy antes.

### 2.3 Lifecycle

Em **Management** → **Lifecycle rules** → **Create lifecycle rule**, crie duas regras:

**Regra A: `arquivar-apos-365-dias`**
1. **Choose a rule scope:** Apply to all objects in the bucket (marque o aviso de confirmação).
2. **Lifecycle rule actions:** marque **Transition current versions of objects between storage classes**.
3. **Storage class transitions:** Glacier Deep Archive, **Days after object creation:** `365`.
4. Marque o aviso sobre custo de transição e salve.
5. **Não** marque nenhuma ação de "Expire". Nenhum documento deve ser apagado.

**Regra B: `limpar-multipart-incompleto`**
1. **Scope:** Apply to all objects in the bucket.
2. **Actions:** marque **Delete expired object delete markers or incomplete multipart uploads**.
3. Marque só **Delete incomplete multipart uploads**, **Number of days:** `7`.
4. Salve.

A regra B apaga apenas pedaços de uploads que nunca foram concluídos. Esses pedaços não são documentos e são cobrados como armazenamento.

> Por padrão o S3 não transiciona objetos menores que 128 KB, porque o custo da transição seria maior que a economia. PDFs muito pequenos ficam no Standard.

O CORS deste bucket fica para o passo 9, porque precisa do domínio do CloudFront.

## Passo 3. Roles do IAM

São três roles:

| Role | Quem usa | O que pode fazer |
|---|---|---|
| `xyz-lambda-create-upload-role` | Lambda de upload | Logs + assumir a role de acesso |
| `xyz-lambda-get-document-role` | Lambda de leitura | Logs + assumir a role de acesso |
| `xyz-documents-access-role` | Assumida pelas Lambdas a cada requisição | S3 e KMS no bucket de documentos |

As Lambdas não acessam o S3 com a própria role. A cada requisição elas assumem `xyz-documents-access-role` com uma session policy limitada a `<BUCKET_DOCUMENTOS>/<userId>/*`. O código dessa session policy está nas Lambdas.

### 3.1 Roles das Lambdas

Repita para `xyz-lambda-create-upload-role` e `xyz-lambda-get-document-role`:

1. **IAM** → **Roles** → **Create role**.
2. **Trusted entity type:** AWS service. **Use case:** Lambda. **Next**.
3. Marque a policy gerenciada **AWSLambdaBasicExecutionRole**. **Next**.
4. **Role name:** o nome da tabela. **Create role**.
5. Abra a role → **Add permissions** → **Create inline policy** → aba **JSON**.
6. Cole `backend/policies/lambda-assume-access-role.json` com `<ACCOUNT_ID>` trocado.
7. **Policy name:** `assume-documents-access-role` → **Create policy**.

### 3.2 Role de acesso aos documentos

1. **IAM** → **Roles** → **Create role**.
2. **Trusted entity type:** Custom trust policy. Cole `backend/policies/access-role-trust-policy.json` com `<ACCOUNT_ID>` trocado. **Next**.
3. Não marque nenhuma policy gerenciada. **Next**.
4. **Role name:** `xyz-documents-access-role` → **Create role**.
5. Abra a role → **Add permissions** → **Create inline policy** → **JSON**.
6. Cole `backend/policies/access-role-permissions.json` trocando `<BUCKET_DOCUMENTOS>`, `<KMS_KEY_ARN>` e `<REGIAO>`.
7. **Policy name:** `documents-access` → **Create policy**.
8. Copie o **ARN** da role (`arn:aws:iam::<ACCOUNT_ID>:role/xyz-documents-access-role`).

Deixe o **Maximum session duration** em 1 hora. As Lambdas pedem no máximo 1 hora, que é o limite para role chaining.

## Passo 4. Lambdas

### 4.1 `xyz-create-upload`

1. **Lambda** → **Create function** → **Author from scratch**.
2. **Function name:** `xyz-create-upload`.
3. **Runtime:** Node.js 24.x. **Architecture:** arm64 (custa menos que x86).
4. **Change default execution role** → **Use an existing role** → `xyz-lambda-create-upload-role`.
5. **Create function**.
6. Na aba **Code**, abra `index.mjs`, apague o conteúdo e cole `backend/lambdas/create-upload/index.mjs`. Clique em **Deploy**.
7. **Configuration** → **General configuration** → **Edit**: Memory `256 MB`, Timeout `15 sec`.
8. **Configuration** → **Environment variables** → **Edit** → adicione:

| Key | Value |
|---|---|
| `BUCKET_NAME` | `<BUCKET_DOCUMENTOS>` |
| `ACCESS_ROLE_ARN` | ARN da `xyz-documents-access-role` |
| `KMS_KEY_ARN` | `<KMS_KEY_ARN>` |
| `MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) |
| `MULTIPART_THRESHOLD_BYTES` | `104857600` (100 MiB) |

Se mudar `MAX_UPLOAD_BYTES`, mude também `maxUploadBytes` em `frontend/config.js`.

**Teste rápido (confere a cadeia IAM → STS antes de seguir):** na aba **Test**, crie um evento com este JSON e clique em **Test**:

```json
{
  "httpMethod": "POST",
  "resource": "/api/uploads",
  "body": "{\"fileName\":\"teste.pdf\",\"contentType\":\"application/pdf\",\"size\":1024}",
  "requestContext": { "authorizer": { "claims": { "sub": "teste-0000" } } }
}
```

O esperado é `statusCode: 200` com uma `url` no body. Se vier 500, veja o log no CloudWatch (link **View CloudWatch logs**) e a seção "Problemas comuns".

### 4.2 `xyz-get-document-url`

Mesmo processo, com estas diferenças:
- **Function name:** `xyz-get-document-url`.
- **Role:** `xyz-lambda-get-document-role`.
- **Código:** `backend/lambdas/get-document-url/index.mjs`.
- **Timeout:** `10 sec`, Memory `256 MB`.
- **Variáveis:** só `BUCKET_NAME`, `ACCESS_ROLE_ARN` e `KMS_KEY_ARN`.

Teste com:

```json
{
  "httpMethod": "GET",
  "resource": "/api/documents",
  "requestContext": { "authorizer": { "claims": { "sub": "teste-0000" } } }
}
```

O esperado é `statusCode: 200` com `{"items":[],"nextCursor":null}`. Esse teste chama o S3 de verdade, então também confere o nome do bucket e a permissão de listagem.

### 4.3 Retenção dos logs (recomendado)

Os log groups `/aws/lambda/xyz-create-upload` e `/aws/lambda/xyz-get-document-url` são criados sem expiração. Em **CloudWatch** → **Log groups** → selecione cada um → **Actions** → **Edit retention setting** → `30 days` (ou o prazo que a empresa exigir).

## Passo 5. Bucket do site e CloudFront

### 5.1 Bucket do site

1. **S3** → **Create bucket** → nome `xyz-site-<ACCOUNT_ID>`.
2. Deixe tudo no padrão: Block all public access marcado, ACLs disabled, criptografia SSE-S3.
3. **Create bucket**. Não envie arquivos ainda.

Não habilite "Static website hosting". O CloudFront lê o bucket pela API do S3 usando OAC.

### 5.2 Distribuição do CloudFront

1. **CloudFront** → **Create distribution**.
2. **Distribution name:** `xyz-docs`.
3. Se o assistente pedir um plano, o **Free** atende este case e já inclui AWS WAF e proteção DDoS. No pay-as-you-go, o WAF tem custo à parte (veja "Custos").
4. **Single website or app** → **Next**.
5. **Origin type:** Amazon S3 → **Browse S3** → `xyz-site-<ACCOUNT_ID>`.
6. **Settings:** Use recommended origin settings. Isso cria o Origin Access Control (OAC). **Next**.
7. **Security protections:** habilite o WAF (incluso no plano Free). **Next** → **Create distribution**.
8. O CloudFront atualiza a bucket policy do site sozinho. Confira em **S3** → bucket do site → **Permissions** → **Bucket policy**: deve existir um statement com `"Service": "cloudfront.amazonaws.com"` e `AWS:SourceArn` apontando para a distribuição.
9. Na distribuição: **General** → **Settings** → **Edit** → **Default root object:** `index.html` → **Save changes**.
10. Copie o **Distribution domain name** (`dxxxx.cloudfront.net`). Esse é o `<DOMINIO_CLOUDFRONT>`.

## Passo 6. Cognito (login)

1. **Cognito** → **User pools** → **Create user pool**.
2. **Application type:** Single-page application (SPA). **Name your application:** `xyz-docs-web`.
3. **Options for sign-in identifiers:** Email.
4. **Self-registration:** habilite se os clientes devem criar a própria conta. Deixe desabilitado se a XYZ vai cadastrar os usuários.
5. **Required attributes for sign-up:** email.
6. **Add a return URL:** `https://<DOMINIO_CLOUDFRONT>/` (com a barra no final).
7. **Create user directory**.

Depois de criado:

1. **App clients** → `xyz-docs-web` → copie o **Client ID**. Confira que **Client secret** está vazio (app do tipo SPA não usa secret).
2. Ainda no app client, aba **Login pages** → **Edit**:
   - **Allowed callback URLs:** `https://<DOMINIO_CLOUDFRONT>/`
   - **Allowed sign-out URLs:** `https://<DOMINIO_CLOUDFRONT>/`
   - **OAuth 2.0 grant types:** Authorization code grant
   - **OpenID Connect scopes:** `openid`, `email`
   - **Save changes**
3. **Branding** → **Domain**: copie o **Cognito domain** (`https://....auth.<REGIAO>.amazoncognito.com`).

Recomendado: em **Authentication** → **Sign-in**, ative MFA (opcional ou obrigatório).

O ID token vale 60 minutos por padrão. O frontend não usa refresh token, então o usuário entra de novo depois desse tempo.

## Passo 7. API Gateway

### 7.1 Criar a API e o authorizer

1. **API Gateway** → **Create API** → **REST API** → **Build**.
2. **New API**, **API name:** `xyz-docs-api`, **API endpoint type:** Regional → **Create API**.
3. Menu **Authorizers** → **Create authorizer**:
   - **Name:** `cognito-xyz`
   - **Type:** Cognito
   - **Cognito user pool:** o pool do passo 6
   - **Token source:** `Authorization`
   - **Create authorizer**

### 7.2 Recursos

Os recursos ficam debaixo de `/api` porque o CloudFront repassa o caminho inteiro (`/api/uploads` chega como `/prod/api/uploads`).

Em **Resources**, use **Create resource** para montar esta árvore. Para recursos com chaves, digite o nome com as chaves, ex.: `{docId}`.

```
/
└── api
    ├── uploads
    │   └── {docId}
    │       └── complete
    └── documents
        └── {docId}
```

Não marque **CORS** em nenhum recurso. O site e a API ficam no mesmo domínio.

### 7.3 Métodos

Selecione o recurso → **Create method** e preencha:

| Recurso | Método | Lambda |
|---|---|---|
| `/api/uploads` | POST | `xyz-create-upload` |
| `/api/uploads/{docId}/complete` | POST | `xyz-create-upload` |
| `/api/documents` | GET | `xyz-get-document-url` |
| `/api/documents/{docId}` | GET | `xyz-get-document-url` |

Em todos:
- **Integration type:** Lambda function
- **Lambda proxy integration:** ligado
- **Lambda function:** a da tabela (na mesma região)
- **Method request settings** → **Authorization:** `cognito-xyz`
- **Create method**

O console adiciona sozinho a permissão para o API Gateway invocar a Lambda.

### 7.4 Publicar

1. **Deploy API** → **Stage:** New stage → **Stage name:** `prod` → **Deploy**.
2. Em **Stages** → `prod` → **Edit** (Stage details): ative **Throttling**, rate `50` e burst `100` requisições por segundo. Ajuste conforme o volume real.
3. Copie a **Invoke URL** (`https://<API_ID>.execute-api.<REGIAO>.amazonaws.com/prod`).

Sempre que alterar recursos ou métodos, faça **Deploy API** de novo no stage `prod`.

## Passo 8. CloudFront: rota `/api/*` para o API Gateway

### 8.1 Origem

1. **CloudFront** → `xyz-docs` → **Origins** → **Create origin**.
2. **Origin domain:** `<API_ID>.execute-api.<REGIAO>.amazonaws.com` (sem `https://` e sem `/prod`).
3. **Protocol:** HTTPS only.
4. **Origin path:** `/prod`.
5. **Name:** `api-gateway` → **Create origin**.

### 8.2 Behavior

1. **Behaviors** → **Create behavior**.
2. **Path pattern:** `/api/*`.
3. **Origin and origin groups:** `api-gateway`.
4. **Viewer protocol policy:** Redirect HTTP to HTTPS.
5. **Allowed HTTP methods:** GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE.
6. **Cache key and origin requests** → Cache policy and origin request policy:
   - **Cache policy:** `CachingDisabled`
   - **Origin request policy:** `AllViewerExceptHostHeader`
7. **Create behavior**. Espere o status sair de "Deploying".

`AllViewerExceptHostHeader` repassa o header `Authorization` para a API. Não use `AllViewer`: ele repassa também o `Host` do CloudFront, e o API Gateway responde 403.

## Passo 9. CORS do bucket de documentos

O navegador envia e baixa os arquivos direto do S3, então o bucket precisa aceitar o domínio do site.

1. Abra `backend/policies/documents-bucket-cors.json` e troque `<DOMINIO_CLOUDFRONT>`.
2. **S3** → bucket de documentos → **Permissions** → **Cross-origin resource sharing (CORS)** → **Edit** → cole → **Save changes**.

O `ExposeHeaders: ETag` é obrigatório para o upload multipart: o navegador precisa ler o ETag de cada parte para fechar o upload.

## Passo 10. Configurar e publicar o frontend

1. Edite `frontend/config.js`:
   - `cognitoDomain`: o domínio do passo 6, com `https://` e sem barra no final.
   - `cognitoClientId`: o Client ID do passo 6.
2. **S3** → bucket do site → **Upload** → arraste **o conteúdo** da pasta `frontend` (`index.html`, `styles.css`, `config.js` e a pasta `js`). O `index.html` precisa ficar na raiz do bucket, não dentro de `frontend/`.
3. **Upload**.
4. **CloudFront** → `xyz-docs` → **Invalidations** → **Create invalidation** → `/*`.
5. Abra `https://<DOMINIO_CLOUDFRONT>/`.

Repita os passos 2 a 4 sempre que mudar o frontend.

## Passo 11. Auditoria e alarmes

### 11.1 CloudTrail (quem acessou cada documento)

Se a conta já tem uma trail, edite essa trail em vez de criar outra. Uma segunda trail com eventos de gerenciamento é cobrada.

1. **CloudTrail** → **Trails** → abra a trail (ou **Create trail**, com um bucket de logs novo).
2. **Data events** → **Edit** → **Add data event type**:
   - **Resource type:** S3
   - **Log selector template:** Custom
   - Condição: `resources.ARN` **starts with** `arn:aws:s3:::<BUCKET_DOCUMENTOS>/`
3. **Save changes**.

Cada evento registra o `RoleSessionName` (`upload-<userId>` ou `read-<userId>`), o que liga o acesso ao usuário.

### 11.2 Alarmes no CloudWatch

1. **SNS** → **Topics** → **Create topic** (Standard) `xyz-alertas` → crie uma subscription de e-mail e confirme pelo e-mail recebido.
2. **CloudWatch** → **Alarms** → **Create alarm**, um para cada métrica:
   - Lambda `xyz-create-upload`, métrica **Errors**, Sum, período 5 min, `> 0`
   - Lambda `xyz-get-document-url`, métrica **Errors**, Sum, período 5 min, `> 0`
   - API Gateway `xyz-docs-api`, stage `prod`, métrica **5XXError**, Sum, período 5 min, `> 0`
3. Ação: notificar `xyz-alertas`.

## Passo 12. Testes

1. **Site:** abra `https://<DOMINIO_CLOUDFRONT>/`. Deve aparecer o botão **Entrar**.
2. **Usuário:** crie um usuário pela tela de cadastro, ou em **Cognito** → **Users** → **Create user**.
3. **Upload simples:** envie um PDF pequeno. Ele deve aparecer em "Meus documentos". No S3, o objeto fica em `<sub-do-usuario>/<uuid>-<nome>.pdf` com criptografia SSE-KMS.
4. **Upload multipart:** envie um arquivo acima de 100 MiB. Para testar com arquivo menor, mude temporariamente `MULTIPART_THRESHOLD_BYTES` para `10485760` (10 MiB) e envie um PDF de 15 MB a 30 MB. Volte o valor depois.
5. **Download:** clique em **Abrir**. O PDF abre numa aba nova e a URL tem `X-Amz-Expires=300`. Depois de 5 minutos o mesmo link responde "Request has expired".
6. **Isolamento:** entre com um segundo usuário. A lista dele deve vir vazia. No DevTools (aba Console) desse segundo usuário, rode trocando o `docId` por um do primeiro usuário:
   ```js
   fetch('/api/documents/<docId-do-usuario-A>', { headers: { Authorization: sessionStorage.getItem('xyz.idToken') } }).then(r => r.status)
   ```
   O esperado é `404`.
7. **Sem token:** `curl -i https://<DOMINIO_CLOUDFRONT>/api/documents` deve responder `401`.
8. **Acesso público:** abra `https://<BUCKET_DOCUMENTOS>.s3.<REGIAO>.amazonaws.com/<chave-de-um-objeto>` sem assinatura. Deve responder `AccessDenied`.
9. **Exclusão bloqueada:** tente apagar um objeto pelo console do S3. Deve falhar com acesso negado.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Cognito mostra `redirect_mismatch` | A Callback URL do app client não é idêntica a `https://<DOMINIO_CLOUDFRONT>/`. A barra final conta. |
| Teste da Lambda falha com `AccessDenied` em `sts:AssumeRole` | Nome errado na trust policy da `xyz-documents-access-role` ou falta a inline policy na role da Lambda. |
| Upload ou download no navegador falha com HTTP 403 | Problema de KMS: `KMS_KEY_ARN` errado na Lambda, ou `<REGIAO>` errada no `kms:ViaService` da policy `documents-access`. O erro detalhado aparece no CloudTrail. |
| `Cannot find package '@aws-sdk/...'` | O runtime não trouxe o pacote. Rode `npm init -y && npm i @aws-sdk/client-s3 @aws-sdk/client-sts @aws-sdk/s3-request-presigner` na pasta da Lambda, compacte `index.mjs` + `node_modules` num .zip e use **Upload from** → **.zip file**. |
| API responde `{"message":"Forbidden"}` via CloudFront | Origin request policy `AllViewer` em vez de `AllViewerExceptHostHeader`. |
| API responde `Missing Authentication Token` | Caminho errado: confira o Origin path `/prod`, os recursos debaixo de `/api` e se a API foi publicada (Deploy API). |
| Todas as chamadas dão `401` | Token source do authorizer diferente de `Authorization`, authorizer apontando para outro user pool, ou API não publicada depois de configurar o authorizer. |
| Upload falha com erro de CORS no console do navegador | CORS do bucket de documentos ausente ou com domínio diferente do CloudFront. |
| Upload grande falha com mensagem sobre ETag | Falta `"ExposeHeaders": ["ETag"]` no CORS. |
| Página em branco com erro de CSP | Domínio próprio no Cognito. Inclua esse domínio no `connect-src` do `index.html`. |
| Site mostra versão antiga | Falta a invalidação `/*` no CloudFront. |
| "Abrir" desabilitado | O documento tem mais de 1 ano e está no Deep Archive. É o comportamento esperado. |

## Decisões tomadas neste guia

- **Object Lock ficou de fora.** Com retenção padrão do Object Lock, o S3 exige um checksum (`Content-MD5` ou `x-amz-checksum-*`) em cada upload, e o navegador teria de calcular esse valor para o arquivo inteiro e para cada parte. A proteção contra exclusão vem do Versioning e da bucket policy que nega `s3:DeleteObject*`. Se a XYZ precisar de retenção com valor legal (WORM), dá para ativar o Object Lock depois e adicionar o cálculo de SHA-256 no frontend.
- **Listagem de documentos.** O case pede só a leitura de um arquivo, mas o frontend precisa mostrar a lista. A rota `GET /api/documents` lista apenas o prefixo do usuário, até 1000 itens por página.
- **Nome do arquivo na chave.** A chave é `<userId>/<uuid>-<nome-sanitizado>`. O UUID evita colisão e o nome deixa a lista legível sem consultar metadados de cada objeto.
- **API Gateway acessível direto.** A Invoke URL do API Gateway continua pública, então dá para chamar a API sem passar pelo CloudFront e pelo WAF. O Cognito Authorizer continua exigindo token. Se quiser fechar esse caminho, configure no CloudFront um header secreto para a origem e valide esse header na API.

## Custos aproximados

Premissa: 50 mil arquivos por mês com 1 MB em média (~50 GB/mês), região `us-east-1`. Confirme na AWS Pricing Calculator.

| Item | Estimativa |
|---|---|
| S3 Standard | ~US$ 14/mês ao fim do primeiro ano (~600 GB) |
| S3 PUT | ~US$ 0,25/mês (50 mil PUTs) |
| Deep Archive | ~US$ 0,60/mês para cada ano arquivado (~600 GB) |
| Transições do lifecycle | ~US$ 2,50/mês a partir do 13º mês (US$ 0,05 por mil objetos) |
| KMS | US$ 1/mês pela chave + requisições |
| API Gateway REST + Lambda | Menos de US$ 2/mês nesse volume |
| Cognito | Os primeiros 10 mil usuários ativos por mês são gratuitos |
| CloudFront | US$ 0 no plano Free (até o limite do plano) |
| WAF | Incluso no plano Free. No pay-as-you-go: ~US$ 5/mês por web ACL + US$ 1 por regra + requisições |
| CloudTrail data events | US$ 0,10 a cada 100 mil eventos |
| Alarmes do CloudWatch | US$ 0,10 por alarme por mês |

## Para desfazer

A bucket policy do bucket de documentos bloqueia exclusões de propósito. Para remover o ambiente, primeiro apague essa bucket policy. Depois esvazie o bucket (incluindo versões) e apague os demais recursos.
