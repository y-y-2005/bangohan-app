/* ==========================================================================
   「ばんごはん、いる？」 - Core Application Logic & Realtime Multi-Device Sync
   ※ キャッシュバスティング版 app.v3.js
   ========================================================================== */

// --- Cloud Sync API Configuration ---
const SYNC_ENDPOINT = 'https://kvdb.io/AeVidZgwuAzpw3ipmY5xhR';

// 同期パラメータ
// KVdb の無料プランは 1,000 リクエスト / IP / 時間。
// 家族が同じWi-Fi配下だと全端末で1つのIPを共有するため、間隔を長めに取る。
// 4端末 × (3600 / 20秒) = 720 req/h → 上限内に収まる。
const POLL_BASE_MS = 20000;      // 通常ポーリング間隔
const POLL_MAX_MS = 120000;      // 429 発生時の最大バックオフ
const PUSH_DEBOUNCE_MS = 800;    // 連打をまとめる
const KEEP_DAYS_BACK = 21;       // 送信対象に含める過去日数（16KB制限対策）
const KEEP_DAYS_FWD = 21;        // 同、未来日数

const STATUS_CONFIG = {
  'S-0': { label: '未回答', icon: '❓', bgClass: 's0', text: '未回答' },
  'S-1': { label: '食べる', icon: '🍚', bgClass: 's1', text: '食べる' },
  'S-2': { label: '食べない', icon: '🙅‍♂️', bgClass: 's2', text: '食べない' },
  'S-3': { label: '遅れて食べる', icon: '🌙', bgClass: 's3', text: '遅れて食べる' },
  'S-4': { label: '自分で用意', icon: '🍳', bgClass: 's4', text: '自分で用意' }
};

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

const INITIAL_STATE = {
  group: {
    id: 'grp_001',
    name: '田中家',
    invite_code: 'BINGO-2026',
    deadline_time: '17:00',
    reminder_time: '15:00'
  },
  config_ts: 0,          // group / users / defaults の最終更新（epoch ms）
  currentUserId: 'u1',
  users: [
    { id: 'u1', name: '母 (調理担当)', role: 'owner', avatar: '👩' },
    { id: 'u2', name: '父', role: 'member', avatar: '👨' },
    { id: 'u3', name: '兄', role: 'member', avatar: '👦' },
    { id: 'u4', name: '妹', role: 'member', avatar: '👧' }
  ],
  defaults: {
    u1: { 0: 'S-1', 1: 'S-1', 2: 'S-1', 3: 'S-1', 4: 'S-1', 5: 'S-1', 6: 'S-1' },
    u2: { 0: 'S-1', 1: 'S-1', 2: 'S-3', 3: 'S-1', 4: 'S-3', 5: 'S-2', 6: 'S-1' },
    u3: { 0: 'S-1', 1: 'S-2', 2: 'S-1', 3: 'S-2', 4: 'S-1', 5: 'S-2', 6: 'S-1' },
    u4: { 0: 'S-1', 1: 'S-1', 2: 'S-1', 3: 'S-1', 4: 'S-1', 5: 'S-1', 6: 'S-1' }
  },
  responses: {} // `${dateStr}_${userId}` をキーとする
};

let appState = {};
let proxyTargetUserId = null;
let syncTimer = null;
let pushTimer = null;

// 同期の内部状態
const syncState = {
  hasFetchedOnce: false,  // 初回フェッチが完了するまでは push しない
  dirty: false,           // 未送信のローカル変更があるか
  fetching: false,
  pushing: false,
  pollMs: POLL_BASE_MS,
  lastError: null
};

/* --------------------------------------------------------------------------
   日付・時刻ヘルパー
   -------------------------------------------------------------------------- */
function getTodayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getFormattedDisplayDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getMonth() + 1}月${d.getDate()}日(${DAY_NAMES[d.getDay()]})`;
}

function getCurrentTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 端末の時計ずれがあっても順序が壊れにくいよう、必ず単調増加させる
let lastIssuedTs = 0;
function nextTs() {
  const now = Date.now();
  lastIssuedTs = now > lastIssuedTs ? now : lastIssuedTs + 1;
  return lastIssuedTs;
}

// 回答オブジェクトを生成（ts が同期のマージキー）
function makeResponse(status, etaTime, note, source) {
  return {
    status: status,
    eta_time: etaTime || '',
    note: note || '',
    source: source,
    updated_at: getCurrentTimeStr(), // 表示用
    ts: nextTs()                     // マージ用（epoch ms）
  };
}

/* --------------------------------------------------------------------------
   アプリ初期化
   -------------------------------------------------------------------------- */
function initApp() {
  loadState();
  applyWeekdayDefaultsForToday();
  setupSimulationUserSelect();
  updateHeaderDateBanner();
  renderHomeTab();

  const savedTheme = localStorage.getItem('bg_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  startCloudSync();

  // 画面復帰時は即同期（バックグラウンド中はポーリングを止める）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startCloudSync();
    } else {
      stopPolling();
    }
  });
  window.addEventListener('online', () => startCloudSync());
}

function loadState() {
  const saved = localStorage.getItem('bg_app_state');
  if (saved) {
    try {
      appState = JSON.parse(saved);
    } catch (e) {
      console.error('Failed to parse saved state:', e);
      appState = JSON.parse(JSON.stringify(INITIAL_STATE));
    }
  } else {
    appState = JSON.parse(JSON.stringify(INITIAL_STATE));
    seedSampleResponses();
  }

  if (typeof appState.config_ts !== 'number') appState.config_ts = 0;
  if (!appState.responses) appState.responses = {};

  const deviceUserId = localStorage.getItem('bg_device_user_id');
  if (deviceUserId && appState.users.some(u => u.id === deviceUserId)) {
    appState.currentUserId = deviceUserId;
  }

  // 起動直後は「ローカル保存のみ」。クラウドへは絶対に push しない。
  saveLocal();
}

// ローカル保存のみ（クラウドに触れない）
function saveLocal() {
  localStorage.setItem('bg_app_state', JSON.stringify(appState));
  localStorage.setItem('bg_device_user_id', appState.currentUserId);
}

// ローカル保存 + クラウドへの送信予約
function saveState() {
  saveLocal();
  syncState.dirty = true;
  schedulePush();
}

// 設定系（group / users / defaults）を変更したときに呼ぶ
function touchConfig() {
  appState.config_ts = nextTs();
}

function resetToSampleData() {
  localStorage.removeItem('bg_app_state');
  appState = JSON.parse(JSON.stringify(INITIAL_STATE));
  seedSampleResponses();
  touchConfig();
  saveLocal();
  syncState.dirty = true;
  initApp();
  showToast('サンプル初期データにリセットしました', 'info');
}

function seedSampleResponses() {
  const today = getTodayStr();
  appState.responses[`${today}_u1`] = makeResponse('S-1', '', '', 'manual');
  appState.responses[`${today}_u2`] = makeResponse('S-3', '21:00', '残業予定', 'manual');
  appState.responses[`${today}_u3`] = makeResponse('S-2', '', 'バイト帰りに外食', 'default');
}

// FR-09: 曜日別デフォルトの自動反映
function applyWeekdayDefaultsForToday() {
  const today = getTodayStr();
  const dayOfWeek = new Date().getDay();

  appState.users.forEach(user => {
    const key = `${today}_${user.id}`;
    if (appState.responses[key]) return;

    const userDefaults = appState.defaults[user.id];
    if (!userDefaults || !userDefaults[dayOfWeek]) return;

    appState.responses[key] = {
      status: userDefaults[dayOfWeek],
      eta_time: userDefaults[dayOfWeek] === 'S-3' ? '20:00' : '',
      note: '',
      source: 'default',
      updated_at: '06:00',
      ts: new Date(`${today}T06:00:00`).getTime()
    };
  });
  saveLocal();
}

/* --------------------------------------------------------------------------
   クラウド同期
   -------------------------------------------------------------------------- */
function cloudUrl() {
  const rawCode = (appState.group && appState.group.invite_code) || 'BINGO-2026';
  const code = rawCode.replace(/[^a-zA-Z0-9]/g, '');
  return `${SYNC_ENDPOINT}/group_${code}`;
}

function startCloudSync() {
  stopPolling();
  syncWithCloud();
  syncTimer = setInterval(syncWithCloud, syncState.pollMs);
}

function stopPolling() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

function applyBackoff() {
  syncState.pollMs = Math.min(syncState.pollMs * 2, POLL_MAX_MS);
  stopPolling();
  syncTimer = setInterval(syncWithCloud, syncState.pollMs);
}

function resetBackoff() {
  if (syncState.pollMs !== POLL_BASE_MS) {
    syncState.pollMs = POLL_BASE_MS;
    stopPolling();
    syncTimer = setInterval(syncWithCloud, syncState.pollMs);
  }
}

// 回答をキー単位で ts 比較してマージする（丸ごと上書きしない）
function mergeResponses(local, cloud) {
  const out = Object.assign({}, local);
  Object.keys(cloud || {}).forEach(k => {
    const c = cloud[k];
    const l = out[k];
    if (!c) return;
    if (!l) { out[k] = c; return; }
    if ((c.ts || 0) > (l.ts || 0)) out[k] = c;
  });
  return out;
}

// 16KB 制限対策: 前後 KEEP_DAYS 日分だけを送信対象にする
function prunedResponses() {
  const min = getTodayStr(-KEEP_DAYS_BACK);
  const max = getTodayStr(KEEP_DAYS_FWD);
  const out = {};
  Object.keys(appState.responses).forEach(k => {
    const datePart = k.slice(0, 10);
    if (datePart >= min && datePart <= max) out[k] = appState.responses[k];
  });
  return out;
}

async function syncWithCloud() {
  if (syncState.fetching) return;
  syncState.fetching = true;

  // ブラウザ／中間キャッシュが古いレスポンスを返すのを防ぐ
  const url = `${cloudUrl()}?_=${Date.now()}`;

  try {
    const res = await fetch(url, { cache: 'no-store' });

    if (res.status === 429) {
      updateSyncBadge('limited');
      applyBackoff();
      return;
    }

    if (res.status === 404) {
      syncState.hasFetchedOnce = true;
      syncState.dirty = true;
      resetBackoff();
      await pushToCloud();
      return;
    }

    if (!res.ok) {
      updateSyncBadge(false);
      return;
    }

    const cloudData = await res.json();
    const before = JSON.stringify(appState.responses) + appState.config_ts;

    if (cloudData && typeof cloudData === 'object') {
      if (cloudData.responses) {
        appState.responses = mergeResponses(appState.responses, cloudData.responses);
      }
      const cloudCfgTs = cloudData.config_ts || 0;
      if (cloudCfgTs > (appState.config_ts || 0)) {
        if (cloudData.users) appState.users = cloudData.users;
        if (cloudData.group) appState.group = Object.assign({}, appState.group, cloudData.group);
        if (cloudData.defaults) appState.defaults = Object.assign({}, appState.defaults, cloudData.defaults);
        appState.config_ts = cloudCfgTs;
      }
    }

    syncState.hasFetchedOnce = true;
    resetBackoff();
    saveLocal();
    updateSyncBadge(true);

    const after = JSON.stringify(appState.responses) + appState.config_ts;
    if (before !== after) renderActiveTab();

    if (syncState.dirty) await pushToCloud();

  } catch (err) {
    syncState.lastError = err;
    updateSyncBadge(false);
  } finally {
    syncState.fetching = false;
  }
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushToCloud(); }, PUSH_DEBOUNCE_MS);
}

async function pushToCloud() {
  // 初回フェッチ前は送らない（他端末のデータを消さないため）
  if (!syncState.hasFetchedOnce) return;
  if (syncState.pushing) return;

  syncState.pushing = true;
  const payload = JSON.stringify({
    group: appState.group,
    users: appState.users,
    defaults: appState.defaults,
    config_ts: appState.config_ts || 0,
    responses: prunedResponses(),
    updated_at: Date.now()
  });

  try {
    // Content-Type を明示しない（CORS プリフライトを避けるため）
    const res = await fetch(cloudUrl(), { method: 'POST', body: payload });

    if (res.status === 429) {
      updateSyncBadge('limited');
      applyBackoff();
      return;
    }
    if (res.ok) {
      syncState.dirty = false;
      updateSyncBadge(true);
    } else {
      updateSyncBadge(false);
    }
  } catch (err) {
    syncState.lastError = err;
    updateSyncBadge(false);
  } finally {
    syncState.pushing = false;
  }
}

function updateSyncBadge(state) {
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;

  if (state === 'limited') {
    badge.textContent = `送信制限中 (${Math.round(syncState.pollMs / 1000)}秒間隔)`;
    badge.className = 'sync-badge offline';
  } else if (state === true) {
    badge.textContent = syncState.dirty ? '送信待ち' : '同期済み';
    badge.className = 'sync-badge';
  } else {
    badge.textContent = 'オフライン (ローカル保存)';
    badge.className = 'sync-badge offline';
  }
}

/* --------------------------------------------------------------------------
   端末のユーザー選択
   -------------------------------------------------------------------------- */
function setupSimulationUserSelect() {
  const select = document.getElementById('currentUserSelect');
  select.innerHTML = '';

  appState.users.forEach(user => {
    const opt = document.createElement('option');
    opt.value = user.id;
    opt.textContent = `${user.avatar} ${user.name}`;
    if (user.id === appState.currentUserId) opt.selected = true;
    select.appendChild(opt);
  });

  updateUserRoleBadge();
}

function switchUser(userId) {
  appState.currentUserId = userId;
  saveLocal();
  updateUserRoleBadge();
  renderHomeTab();
  showToast(`この端末の対象メンバーを「${getCurrentUser().name}」に設定しました`, 'info');
}

function getCurrentUser() {
  return appState.users.find(u => u.id === appState.currentUserId) || appState.users[0];
}

function updateUserRoleBadge() {
  const user = getCurrentUser();
  const badge = document.getElementById('currentUserRole');
  if (user.role === 'owner') {
    badge.textContent = '調理担当者(管理者)';
    badge.style.background = 'var(--primary)';
  } else {
    badge.textContent = 'メンバー';
    badge.style.background = 'var(--secondary)';
  }
}

function updateHeaderDateBanner() {
  document.getElementById('currentDateDisplay').textContent = getFormattedDisplayDate(0);

  const deadline = appState.group.deadline_time || '17:00';
  const deadlineEl = document.getElementById('deadlineDisplay');

  if (getCurrentTimeStr() > deadline) {
    deadlineEl.textContent = `締切後 (${deadline})`;
    deadlineEl.classList.add('passed');
  } else {
    deadlineEl.textContent = `締切 ${deadline}`;
    deadlineEl.classList.remove('passed');
  }

  document.getElementById('groupNameDisplay').textContent = appState.group.name;
  document.getElementById('settingsGroupName').value = appState.group.name;
  document.getElementById('settingsDeadlineTime').value = appState.group.deadline_time;
  document.getElementById('settingsReminderTime').value = appState.group.reminder_time;
}

/* --------------------------------------------------------------------------
   ホームタブ描画
   -------------------------------------------------------------------------- */
function renderHomeTab() {
  const today = getTodayStr();
  const currentUser = getCurrentUser();

  let countEat = 0, countSkip = 0, countPending = 0;

  appState.users.forEach(u => {
    const res = appState.responses[`${today}_${u.id}`];
    const status = res ? res.status : 'S-0';
    if (status === 'S-1' || status === 'S-3') countEat++;
    else if (status === 'S-2' || status === 'S-4') countSkip++;
    else countPending++;
  });

  document.getElementById('sumEat').textContent = countEat;
  document.getElementById('sumSkip').textContent = countSkip;
  document.getElementById('sumPending').textContent = countPending;

  const myResponse = appState.responses[`${today}_${currentUser.id}`];
  const myStatus = myResponse ? myResponse.status : 'S-0';

  ['S-1', 'S-2', 'S-3', 'S-4'].forEach(sCode => {
    const codeTag = sCode.toLowerCase().replace('-', '');
    const btn = document.getElementById(`btn-${codeTag}`);
    if (btn) {
      btn.className = 'status-btn';
      if (myStatus === sCode) btn.classList.add(`selected-${codeTag}`);
    }
  });

  const extraOptions = document.getElementById('extraOptions');
  const etaGroup = document.getElementById('etaGroup');
  const etaInput = document.getElementById('etaInput');
  const noteInput = document.getElementById('noteInput');

  if (myStatus !== 'S-0') {
    extraOptions.style.display = 'flex';
    if (myStatus === 'S-3') {
      etaGroup.style.display = 'flex';
      if (document.activeElement !== etaInput) {
        etaInput.value = (myResponse && myResponse.eta_time) ? myResponse.eta_time : '20:00';
      }
    } else {
      etaGroup.style.display = 'none';
    }
    if (document.activeElement !== noteInput) {
      noteInput.value = (myResponse && myResponse.note) ? myResponse.note : '';
    }
  } else {
    extraOptions.style.display = 'none';
  }

  const container = document.getElementById('memberListContainer');
  container.innerHTML = '';

  appState.users.forEach(u => {
    const res = appState.responses[`${today}_${u.id}`];
    const statusKey = res ? res.status : 'S-0';
    const cfg = STATUS_CONFIG[statusKey];

    const isUnanswered = statusKey === 'S-0';
    const isCurrentUser = u.id === currentUser.id;
    const isOwner = currentUser.role === 'owner';

    const card = document.createElement('div');
    card.className = `member-card ${isUnanswered ? 'is-unanswered' : ''}`;

    let statusLabelText = cfg.label;
    if (statusKey === 'S-3' && res && res.eta_time) statusLabelText += ` (${res.eta_time}頃)`;

    let noteHtml = '';
    if (res && res.note) {
      noteHtml = `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">"${escapeHtml(res.note)}"</div>`;
    }

    let autoTagHtml = '';
    if (res && res.source === 'default') autoTagHtml = `<span class="auto-tag">(自動)</span>`;
    else if (res && res.source === 'proxy') autoTagHtml = `<span class="auto-tag">(代理)</span>`;

    let actionBtnHtml = '';
    if (isUnanswered && !isCurrentUser) {
      actionBtnHtml = `<button class="poke-btn" onclick="pokeMember('${u.id}', '${escapeHtml(u.name)}')">つつく</button>`;
    } else if (isOwner && !isCurrentUser) {
      actionBtnHtml = `<button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;" onclick="openProxyModal('${u.id}')">代理入力</button>`;
    }

    card.innerHTML = `
      <div class="member-info">
        <div class="avatar">${u.avatar}</div>
        <div class="member-details">
          <div class="member-name">
            <span>${escapeHtml(u.name)} ${isCurrentUser ? '(あなた)' : ''}</span>
            ${autoTagHtml}
          </div>
          <div class="update-time">${res ? `最終更新: ${res.updated_at}` : '未登録'}</div>
          ${noteHtml}
        </div>
      </div>
      <div class="member-status-box">
        <span class="status-badge ${cfg.bgClass}">
          <span>${cfg.icon}</span>
          <span>${statusLabelText}</span>
        </span>
        ${actionBtnHtml}
      </div>
    `;

    container.appendChild(card);
  });
}

function renderActiveTab() {
  const active = document.querySelector('.tab-pane.active');
  if (!active) return;
  const id = active.id.replace('tab-', '');
  if (id === 'home') renderHomeTab();
  else if (id === 'week') renderWeekTab();
  else if (id === 'family') renderFamilyTab();
  else if (id === 'history') renderHistoryTab();
}

/* --------------------------------------------------------------------------
   回答登録
   -------------------------------------------------------------------------- */
function submitStatus(statusCode) {
  const today = getTodayStr();
  const user = getCurrentUser();
  const key = `${today}_${user.id}`;

  appState.responses[key] = makeResponse(
    statusCode,
    statusCode === 'S-3' ? (document.getElementById('etaInput').value || '20:00') : '',
    document.getElementById('noteInput').value || '',
    'manual'
  );

  saveState();
  renderHomeTab();

  const nowTimeStr = getCurrentTimeStr();
  const deadline = appState.group.deadline_time || '17:00';
  if (nowTimeStr > deadline) {
    showToast(`締切後の変更: ${user.name}さんが『${STATUS_CONFIG[statusCode].label}』に変更しました (${nowTimeStr})`, 'warning');
  } else {
    showToast(`夕食の予定を「${STATUS_CONFIG[statusCode].label}」に更新しました`, 'info');
  }
}

function saveExtraDetails() {
  const today = getTodayStr();
  const user = getCurrentUser();
  const key = `${today}_${user.id}`;
  const cur = appState.responses[key];
  if (!cur) return;

  appState.responses[key] = makeResponse(
    cur.status,
    document.getElementById('etaInput').value,
    document.getElementById('noteInput').value,
    'manual'
  );
  saveState();
  renderHomeTab();
}

function pokeMember(userId, userName) {
  showToast(`${userName}さんに夕食要否のリマインドを送信しました`, 'info');
}

/* --------------------------------------------------------------------------
   代理入力 (FR-11)
   -------------------------------------------------------------------------- */
function openProxyModal(userId) {
  proxyTargetUserId = userId;
  const user = appState.users.find(u => u.id === userId);
  if (!user) return;

  document.getElementById('proxyMemberName').textContent = user.name;

  const existing = appState.responses[`${getTodayStr()}_${userId}`];
  if (existing) {
    document.getElementById('proxyStatusSelect').value = existing.status;
    document.getElementById('proxyEtaInput').value = existing.eta_time || '20:00';
    document.getElementById('proxyNoteInput').value = existing.note || '';
  } else {
    document.getElementById('proxyStatusSelect').value = 'S-1';
  }

  toggleProxyExtra();
  document.getElementById('proxyModal').classList.add('active');
}

function closeProxyModal() {
  document.getElementById('proxyModal').classList.remove('active');
  proxyTargetUserId = null;
}

function toggleProxyExtra() {
  const status = document.getElementById('proxyStatusSelect').value;
  document.getElementById('proxyEtaGroup').style.display = status === 'S-3' ? 'block' : 'none';
}

function submitProxyStatus() {
  if (!proxyTargetUserId) return;

  const statusCode = document.getElementById('proxyStatusSelect').value;
  const targetUser = appState.users.find(u => u.id === proxyTargetUserId);

  appState.responses[`${getTodayStr()}_${proxyTargetUserId}`] = makeResponse(
    statusCode,
    statusCode === 'S-3' ? document.getElementById('proxyEtaInput').value : '',
    document.getElementById('proxyNoteInput').value || '',
    'proxy'
  );

  saveState();
  closeProxyModal();
  renderHomeTab();
  showToast(`代理入力: ${targetUser.name}さんの回答を更新しました`, 'info');
}

/* --------------------------------------------------------------------------
   週間ビュー (FR-08)
   -------------------------------------------------------------------------- */
function renderWeekTab() {
  const table = document.getElementById('weekTable');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  trHead.innerHTML = `<th>メンバー</th>`;
  for (let i = 0; i < 7; i++) {
    trHead.innerHTML += `<th class="${i === 0 ? 'today' : ''}">${getFormattedDisplayDate(i)}</th>`;
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  appState.users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="font-weight: 800; text-align: left;">${u.avatar} ${escapeHtml(u.name)}</td>`;

    for (let i = 0; i < 7; i++) {
      const res = appState.responses[`${getTodayStr(i)}_${u.id}`];
      const cfg = STATUS_CONFIG[res ? res.status : 'S-0'];
      tr.innerHTML += `<td><div class="matrix-cell status-badge ${cfg.bgClass}">${cfg.icon} ${cfg.text}</div></td>`;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

/* --------------------------------------------------------------------------
   曜日別デフォルト (FR-09)
   -------------------------------------------------------------------------- */
function renderDefaultTab() {
  const userSelect = document.getElementById('defaultUserSelect');
  if (userSelect.children.length === 0) {
    appState.users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `${u.avatar} ${u.name}`;
      userSelect.appendChild(opt);
    });
  }

  const selectedUserId = userSelect.value || appState.users[0].id;
  const userDefaults = appState.defaults[selectedUserId] || {};

  const rowsContainer = document.getElementById('defaultScheduleRows');
  rowsContainer.innerHTML = '';

  DAY_NAMES.forEach((dayName, dayIdx) => {
    const cur = userDefaults[dayIdx] || 'S-1';
    const row = document.createElement('div');
    row.className = 'day-row';
    row.innerHTML = `
      <div class="day-name">毎週${dayName}曜</div>
      <select class="input-select" style="width: auto; flex: 1;" id="def-day-${dayIdx}">
        <option value="S-1" ${cur === 'S-1' ? 'selected' : ''}>食べる</option>
        <option value="S-2" ${cur === 'S-2' ? 'selected' : ''}>食べない</option>
        <option value="S-3" ${cur === 'S-3' ? 'selected' : ''}>遅れて食べる</option>
        <option value="S-4" ${cur === 'S-4' ? 'selected' : ''}>自分で用意する</option>
      </select>
    `;
    rowsContainer.appendChild(row);
  });
}

function saveDefaultSchedule() {
  const userId = document.getElementById('defaultUserSelect').value;
  if (!appState.defaults[userId]) appState.defaults[userId] = {};

  for (let i = 0; i < 7; i++) {
    appState.defaults[userId][i] = document.getElementById(`def-day-${i}`).value;
  }

  touchConfig();
  saveState();
  showToast('曜日別デフォルト設定を保存しました', 'info');
}

/* --------------------------------------------------------------------------
   家族・メンバー管理 (UI-05, FR-05)
   -------------------------------------------------------------------------- */
function renderFamilyTab() {
  const container = document.getElementById('familyMemberList');
  container.innerHTML = '';

  appState.users.forEach(u => {
    const card = document.createElement('div');
    card.className = 'member-card';
    card.innerHTML = `
      <div class="member-info">
        <div class="avatar">${u.avatar}</div>
        <div class="member-details">
          <div class="member-name">${escapeHtml(u.name)}</div>
          <div class="update-time">${u.role === 'owner' ? '調理担当 (管理者)' : 'メンバー'}</div>
        </div>
      </div>
      <div>
        ${u.role !== 'owner' ? `<button class="btn btn-secondary" style="font-size: 11px; color: var(--status-s2-text);" onclick="removeMember('${u.id}')">削除</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

function showInviteModal() { document.getElementById('inviteModal').classList.add('active'); }
function closeInviteModal() { document.getElementById('inviteModal').classList.remove('active'); }

function copyInviteLink() {
  navigator.clipboard.writeText(window.location.href);
  showToast('WebアプリURLをクリップボードにコピーしました', 'info');
}

function showAddMemberModal() { document.getElementById('addMemberModal').classList.add('active'); }
function closeAddMemberModal() { document.getElementById('addMemberModal').classList.remove('active'); }

function addNewMember() {
  const name = document.getElementById('newMemberName').value.trim();
  const avatar = document.getElementById('newMemberAvatar').value;

  if (!name) {
    showToast('名前を入力してください', 'warning');
    return;
  }

  const newId = `u_${Date.now()}`;
  appState.users.push({ id: newId, name, role: 'member', avatar });
  appState.defaults[newId] = { 0: 'S-1', 1: 'S-1', 2: 'S-1', 3: 'S-1', 4: 'S-1', 5: 'S-1', 6: 'S-1' };

  touchConfig();
  saveState();
  closeAddMemberModal();
  setupSimulationUserSelect();
  renderFamilyTab();
  showToast(`${name}さんを追加しました`, 'info');
}

function removeMember(userId) {
  if (!confirm('このメンバーをグループから削除しますか？')) return;
  appState.users = appState.users.filter(u => u.id !== userId);
  touchConfig();
  saveState();
  setupSimulationUserSelect();
  renderFamilyTab();
  showToast('メンバーを削除しました', 'info');
}

/* --------------------------------------------------------------------------
   設定 (UI-06)
   -------------------------------------------------------------------------- */
function saveGroupSettings() {
  appState.group.name = document.getElementById('settingsGroupName').value;
  appState.group.deadline_time = document.getElementById('settingsDeadlineTime').value;
  appState.group.reminder_time = document.getElementById('settingsReminderTime').value;

  touchConfig();
  saveState();
  updateHeaderDateBanner();
  showToast('グループ設定を更新しました', 'info');
}

function triggerReminderNotification() {
  const today = getTodayStr();
  const unanswered = appState.users.filter(u => {
    const r = appState.responses[`${today}_${u.id}`];
    return !r || r.status === 'S-0';
  });

  if (unanswered.length === 0) {
    showToast('15:00 リマインド: 全員が回答済みのため送信されませんでした', 'info');
  } else {
    const names = unanswered.map(u => u.name).join('さん, ') + 'さん';
    showToast(`[15:00 自動リマインド] ${names}へ通知を送信しました`, 'info');
  }
}

function triggerDeadlineSummaryNotification() {
  const today = getTodayStr();
  let eat = 0, skip = 0, pending = 0;

  appState.users.forEach(u => {
    const r = appState.responses[`${today}_${u.id}`];
    const s = r ? r.status : 'S-0';
    if (s === 'S-1' || s === 'S-3') eat++;
    else if (s === 'S-2' || s === 'S-4') skip++;
    else pending++;
  });

  const cook = appState.users.find(u => u.role === 'owner') || appState.users[0];
  showToast(`[17:00 締切サマリ] ${cook.name}さんへ通知: 食べる ${eat}名 / 不要 ${skip}名 / 未回答 ${pending}名`, 'warning');
}

/* --------------------------------------------------------------------------
   履歴 (FR-14)
   -------------------------------------------------------------------------- */
function renderHistoryTab() {
  const container = document.getElementById('historyContainer');
  container.innerHTML = '';

  for (let i = 1; i <= 5; i++) {
    const dateStr = getTodayStr(-i);
    let eat = 0, skip = 0, pending = 0;

    appState.users.forEach(u => {
      const r = appState.responses[`${dateStr}_${u.id}`];
      const s = r ? r.status : 'S-0';
      if (s === 'S-1' || s === 'S-3') eat++;
      else if (s === 'S-2' || s === 'S-4') skip++;
      else pending++;
    });

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div>
        <div class="history-date">${getFormattedDisplayDate(-i)}</div>
        <div class="history-stats">食べる ${eat}名 / 食べない ${skip}名 / 未回答 ${pending}名</div>
      </div>
      <div style="color: var(--secondary); font-weight: 800; font-size: 13px;">${pending === 0 ? '確定' : '未確定'}</div>
    `;
    container.appendChild(item);
  }
}

/* --------------------------------------------------------------------------
   タブ切替・トースト・テーマ
   -------------------------------------------------------------------------- */
function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const activePane = document.getElementById(`tab-${tabId}`);
  const activeNav = document.getElementById(`nav-${tabId}`);
  if (activePane) activePane.classList.add('active');
  if (activeNav) activeNav.classList.add('active');

  if (tabId === 'default') renderDefaultTab();
  else renderActiveTab();
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('bg_theme', next);
  showToast(`テーマを「${next === 'dark' ? 'ダーク' : 'ライト'}モード」に変更しました`, 'info');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

document.addEventListener('DOMContentLoaded', initApp);
