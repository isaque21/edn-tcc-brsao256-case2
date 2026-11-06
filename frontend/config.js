// Configuração do frontend. Preencha com os valores criados no console da AWS
// (veja docs/guia-backend-console.md, passo 10).
//
// Os limites abaixo precisam bater com as variáveis de ambiente da Lambda
// xyz-create-upload (MAX_UPLOAD_BYTES). A Lambda é quem decide de verdade;
// aqui eles servem só para avisar o usuário antes de enviar.

export const config = {
  // Domínio do Cognito (managed login), com https:// e sem barra no final.
  // Ex.: https://us-east-1abc123.auth.us-east-1.amazoncognito.com
  // Se usar domínio próprio no Cognito, inclua-o também no connect-src do CSP em index.html.
  cognitoDomain: 'https://SEU-DOMINIO.auth.SUA-REGIAO.amazoncognito.com',

  // App client ID do User Pool (tipo SPA, sem client secret).
  cognitoClientId: 'SEU_APP_CLIENT_ID',

  // Precisam estar cadastradas no app client como Callback URL e Sign-out URL.
  redirectUri: `${window.location.origin}/`,
  logoutUri: `${window.location.origin}/`,
  scopes: 'openid email',

  // A API fica no mesmo domínio do site, atrás do CloudFront (behavior /api/*).
  apiBasePath: '/api',

  allowedTypes: {
    'application/pdf': 'PDF',
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
  },
  maxUploadBytes: 5 * 1024 ** 3, // 5 GiB

  // Quantas partes de um upload multipart sobem ao mesmo tempo.
  uploadConcurrency: 4,
  // Tentativas por parte antes de desistir do arquivo.
  partAttempts: 3,
};
