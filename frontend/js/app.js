import { config } from '../config.js';
import { login, logout, handleRedirect, getSession, clearSession } from './auth.js';
import { api } from './api.js';
import { uploadFile } from './upload.js';
import { formatBytes, formatDate } from './format.js';

const $ = (id) => document.getElementById(id);

let nextCursor = null;

// ---------- mensagens e sessão ----------

function showError(message) {
  const box = $('global-error');
  box.textContent = message;
  box.hidden = false;
}

function clearError() {
  $('global-error').hidden = true;
}

function showLoginView() {
  $('app-view').hidden = true;
  $('user-box').hidden = true;
  $('login-view').hidden = false;
}

// Trata erros vindos da API. Sessão expirada leva de volta para a tela de login.
function handleError(err) {
  if (err?.status === 401) {
    clearSession();
    showLoginView();
  }
  showError(err?.message || 'Erro inesperado.');
}

// ---------- upload ----------

function validateFile(file) {
  if (!config.allowedTypes[file.type]) {
    const allowed = Object.values(config.allowedTypes).join(', ');
    return `Tipo de arquivo não permitido. Envie ${allowed}.`;
  }
  if (file.size === 0) return 'O arquivo está vazio.';
  if (file.size > config.maxUploadBytes) {
    return `O arquivo passa do limite de ${formatBytes(config.maxUploadBytes)}.`;
  }
  return null;
}

function createUploadItem(file) {
  const item = document.createElement('li');
  item.className = 'upload-item';

  const row = document.createElement('div');
  row.className = 'upload-row';
  const name = document.createElement('span');
  name.className = 'upload-name';
  name.textContent = `${file.name} (${formatBytes(file.size)})`;
  const status = document.createElement('span');
  status.className = 'upload-status';
  status.textContent = 'Preparando…';
  row.append(name, status);

  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = 0;

  item.append(row, bar);
  $('upload-list').prepend(item);

  return {
    progress(fraction) {
      const pct = Math.round(fraction * 100);
      bar.value = pct;
      status.textContent = `${pct}%`;
    },
    done() {
      bar.value = 100;
      status.textContent = 'Enviado';
      status.classList.add('ok');
    },
    fail(message) {
      bar.hidden = true;
      status.textContent = message;
      status.classList.add('error');
    },
  };
}

async function handleFile(file) {
  const ui = createUploadItem(file);
  const problem = validateFile(file);
  if (problem) {
    ui.fail(problem);
    return false;
  }
  try {
    await uploadFile(file, (fraction) => ui.progress(fraction));
    ui.done();
    return true;
  } catch (err) {
    ui.fail(err.message || 'Falha no envio.');
    if (err?.status === 401) handleError(err);
    return false;
  }
}

async function handleFiles(fileList) {
  clearError();
  const files = Array.from(fileList);
  let anySuccess = false;
  // Um arquivo por vez. Cada arquivo grande já sobe em partes paralelas.
  for (const file of files) {
    if (await handleFile(file)) anySuccess = true;
  }
  if (anySuccess) await loadDocuments(true);
}

function setupUpload() {
  const input = $('file-input');
  const dropzone = $('dropzone');

  input.accept = Object.keys(config.allowedTypes).join(',');
  $('limits-hint').textContent =
    `${Object.values(config.allowedTypes).join(', ')} até ${formatBytes(config.maxUploadBytes)}`;

  input.addEventListener('change', () => {
    if (input.files?.length) handleFiles(input.files);
    input.value = '';
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    if (event.dataTransfer?.files?.length) handleFiles(event.dataTransfer.files);
  });
}

// ---------- documentos ----------

function renderRow(doc) {
  const tr = document.createElement('tr');

  const name = document.createElement('td');
  name.className = 'name';
  name.textContent = doc.fileName;
  name.title = doc.fileName;

  const size = document.createElement('td');
  size.textContent = formatBytes(doc.size);

  const date = document.createElement('td');
  date.textContent = formatDate(doc.lastModified);

  const status = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${doc.archived ? 'archived' : 'available'}`;
  badge.textContent = doc.archived ? 'Arquivado' : 'Disponível';
  status.append(badge);

  const actions = document.createElement('td');
  actions.className = 'actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn btn-secondary';
  open.textContent = 'Abrir';
  if (doc.archived) {
    open.disabled = true;
    open.title = 'Documento com mais de 1 ano, guardado na camada de arquivamento.';
  } else {
    open.addEventListener('click', () => openDocument(doc.docId));
  }
  actions.append(open);

  tr.append(name, size, date, status, actions);
  return tr;
}

async function loadDocuments(reset) {
  const body = $('docs-body');
  const loading = $('docs-loading');
  const refresh = $('refresh-btn');
  const more = $('more-btn');

  if (reset) nextCursor = null;
  loading.hidden = false;
  refresh.disabled = true;
  more.disabled = true;

  try {
    const result = await api.listDocuments(reset ? null : nextCursor);
    if (reset) body.replaceChildren();
    for (const doc of result.items) body.append(renderRow(doc));
    nextCursor = result.nextCursor;

    const hasRows = body.children.length > 0;
    $('docs-table').hidden = !hasRows;
    $('docs-empty').hidden = hasRows;
    more.hidden = !nextCursor;
  } catch (err) {
    handleError(err);
  } finally {
    loading.hidden = true;
    refresh.disabled = false;
    more.disabled = false;
  }
}

async function openDocument(docId) {
  clearError();
  // Abre a aba antes do await para o navegador não bloquear como pop-up.
  const win = window.open('', '_blank');
  try {
    const { url } = await api.getDocumentUrl(docId);
    if (win) {
      win.opener = null;
      win.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (err) {
    win?.close();
    handleError(err);
  }
}

function setupDocuments() {
  $('refresh-btn').addEventListener('click', () => loadDocuments(true));
  $('more-btn').addEventListener('click', () => loadDocuments(false));
}

// ---------- início ----------

async function init() {
  $('login-btn').addEventListener('click', () => {
    login().catch((err) => showError(err.message));
  });
  $('logout-btn').addEventListener('click', logout);

  try {
    await handleRedirect();
  } catch (err) {
    showError(err.message);
  }

  const session = getSession();
  if (!session) {
    showLoginView();
    return;
  }

  $('user-email').textContent = session.claims.email || session.claims['cognito:username'] || '';
  $('user-box').hidden = false;
  $('login-view').hidden = true;
  $('app-view').hidden = false;

  setupUpload();
  setupDocuments();
  await loadDocuments(true);
}

init();
