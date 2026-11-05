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
