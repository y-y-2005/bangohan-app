/* ==========================================================================
   「ばんごはん、いる？」 - Core Application Logic & Realtime Multi-Device Sync
   ========================================================================== */

// --- Cloud Sync API Configuration ---
// Uses dedicated KV Cloud Database REST Endpoint for instant, zero-config multi-device sync
const SYNC_ENDPOINT = 'https://kvdb.io/AeVidZgwuAzpw3ipmY5xhR';

const STATUS_CONFIG = {
  'S-0': { label: '未回答', icon: '❓', bgClass: 's0', text: '未回答' },
  'S-1': { label: '食べる', icon: '🍚', bgClass: 's1', text: '食べる' },
  'S-2': { label: '食べない', icon: '🙅‍♂️', bgClass: 's2', text: '食べない' },
  'S-3': { label: '遅れて食べる', icon: '🌙', bgClass: 's3', text: '遅れて食べる' },
  'S-4': { label: '自分で用意', icon: '🍳', bgClass: 's4', text: '自分で用意' }
};

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// Initial Default State
const INITIAL_STATE = {
  group: {
    id: 'grp_001',
    name: '田中家',
    invite_code: 'BINGO-2026',
    deadline_time: '17:00',
    reminder_time: '15:00'
  },
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
  responses: {} // Keyed by `${dateStr}_${userId}`
};

let appState = {};
let proxyTargetUserId = null;
let syncTimer = null;

// Helper: Format Date String YYYY-MM-DD
function getTodayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Format Display Date (e.g. 8月24日(月))
function getFormattedDisplayDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const month = d.getMonth() + 1;
  const date = d.getDate();
  const dayName = DAY_NAMES[d.getDay()];
  return `${month}月${date}日(${dayName})`;
}

// Current Time HH:MM
function getCurrentTimeStr() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// --- App Initialization ---
function initApp() {
  loadState();
  applyWeekdayDefaultsForToday();
  setupSimulationUserSelect();
  updateHeaderDateBanner();
  renderHomeTab();
  
  // Apply saved theme preference
  const savedTheme = localStorage.getItem('bg_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  // Start Realtime Cloud Synchronization
  startCloudSync();
}

// Load state from LocalStorage or initialize
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
    saveState();
  }

  // Read device identity preference
  const deviceUserId = localStorage.getItem('bg_device_user_id');
  if (deviceUserId && appState.users.some(u => u.id === deviceUserId)) {
    appState.currentUserId = deviceUserId;
  }
}

function saveState(skipCloudSync = false) {
  localStorage.setItem('bg_app_state', JSON.stringify(appState));
  localStorage.setItem('bg_device_user_id', appState.currentUserId);
  
  if (!skipCloudSync) {
    pushToCloud();
  }
}

function resetToSampleData() {
  localStorage.removeItem('bg_app_state');
  appState = JSON.parse(JSON.stringify(INITIAL_STATE));
  seedSampleResponses();
  saveState();
  initApp();
  showToast('🔄 サンプル初期データにリセットしました！', 'info');
}

// Seed realistic demo responses for today
function seedSampleResponses() {
  const today = getTodayStr();
  appState.responses[`${today}_u1`] = { status: 'S-1', eta_time: '', note: '', source: 'manual', updated_at: '15:02' };
  appState.responses[`${today}_u2`] = { status: 'S-3', eta_time: '21:00', note: '残業予定', source: 'manual', updated_at: '16:40' };
  appState.responses[`${today}_u3`] = { status: 'S-2', eta_time: '', note: 'バイト帰りに外食', source: 'default', updated_at: '06:00' };
}

// Auto-fill weekday default responses if not yet answered (FR-09)
function applyWeekdayDefaultsForToday() {
  const today = getTodayStr();
  const dayOfWeek = new Date().getDay();
  
  appState.users.forEach(user => {
    const key = `${today}_${user.id}`;
    if (!appState.responses[key]) {
      const userDefaults = appState.defaults[user.id];
      if (userDefaults && userDefaults[dayOfWeek]) {
        appState.responses[key] = {
          status: userDefaults[dayOfWeek],
          eta_time: userDefaults[dayOfWeek] === 'S-3' ? '20:00' : '',
          note: '',
          source: 'default',
          updated_at: '06:00'
        };
      }
    }
  });
}

// Realtime Sync Engine (Polling & Push)
function startCloudSync() {
  syncWithCloud();
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncWithCloud, 3000); // 3-second live sync interval
}

async function syncWithCloud() {
  const rawCode = (appState.group && appState.group.invite_code) ? appState.group.invite_code : 'BINGO-2026';
  const code = rawCode.replace(/[^a-zA-Z0-9]/g, '');
  const url = `${SYNC_ENDPOINT}/group_${code}`;

  try {
    const res = await fetch(url);
    if (res.ok) {
      const cloudData = await res.json();
      if (cloudData && cloudData.responses) {
        appState.responses = Object.assign({}, appState.responses, cloudData.responses);
        if (cloudData.users) appState.users = cloudData.users;
        if (cloudData.group) appState.group = Object.assign({}, appState.group, cloudData.group);
        if (cloudData.defaults) appState.defaults = Object.assign({}, appState.defaults, cloudData.defaults);
        
        saveState(true);
        renderHomeTab();
        updateSyncBadge(true);
      }
    }
  } catch (err) {
    updateSyncBadge(false);
  }
}

async function pushToCloud() {
  const rawCode = (appState.group && appState.group.invite_code) ? appState.group.invite_code : 'BINGO-2026';
  const code = rawCode.replace(/[^a-zA-Z0-9]/g, '');
  const url = `${SYNC_ENDPOINT}/group_${code}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        group: appState.group,
        users: appState.users,
        defaults: appState.defaults,
        responses: appState.responses,
        updated_at: Date.now()
      })
    });
    if (res.ok) {
      updateSyncBadge(true);
    }
  } catch (err) {
    updateSyncBadge(false);
  }
}

function updateSyncBadge(isOnline) {
  const badge = document.getElementById('syncStatusBadge');
  if (badge) {
    if (isOnline) {
      badge.textContent = '📡 リアルタイム同期中';
      badge.className = 'sync-badge';
    } else {
      badge.textContent = '⚡ オフライン (ローカル保存)';
      badge.className = 'sync-badge offline';
    }
  }
}

// Setup User Switcher / Device Identity Bar
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
  saveState();
  updateUserRoleBadge();
  renderHomeTab();
  showToast(`👤 この端末の対象メンバーを「${getCurrentUser().name}」に設定しました`, 'info');
}

function getCurrentUser() {
  return appState.users.find(u => u.id === appState.currentUserId) || appState.users[0];
}

function updateUserRoleBadge() {
  const user = getCurrentUser();
  const badge = document.getElementById('currentUserRole');
  if (user.role === 'owner') {
    badge.textContent = '👑 調理担当者(管理者)';
    badge.style.background = 'var(--primary)';
  } else {
    badge.textContent = '👤 メンバー';
    badge.style.background = 'var(--secondary)';
  }
}

// Update Top Date & Deadline Banner
function updateHeaderDateBanner() {
  document.getElementById('currentDateDisplay').textContent = `📅 ${getFormattedDisplayDate(0)}`;
  
  const deadline = appState.group.deadline_time || '17:00';
  const deadlineEl = document.getElementById('deadlineDisplay');
  
  const nowStr = getCurrentTimeStr();
  if (nowStr > deadline) {
    deadlineEl.textContent = `⏰ 締切後 (${deadline})`;
    deadlineEl.classList.add('passed');
  } else {
    deadlineEl.textContent = `⏰ 締切 ${deadline}`;
    deadlineEl.classList.remove('passed');
  }

  document.getElementById('groupNameDisplay').textContent = appState.group.name;
  document.getElementById('settingsGroupName').value = appState.group.name;
  document.getElementById('settingsDeadlineTime').value = appState.group.deadline_time;
  document.getElementById('settingsReminderTime').value = appState.group.reminder_time;
}

// --- Render Home Tab (UI-01, FR-01, FR-02, FR-04) ---
function renderHomeTab() {
  const today = getTodayStr();
  const currentUser = getCurrentUser();
  
  // 1. Calculate Summary Counts
  let countEat = 0;
  let countSkip = 0;
  let countPending = 0;
  
  appState.users.forEach(u => {
    const res = appState.responses[`${today}_${u.id}`];
    const status = res ? res.status : 'S-0';
    
    if (status === 'S-1' || status === 'S-3') {
      countEat++;
    } else if (status === 'S-2' || status === 'S-4') {
      countSkip++;
    } else {
      countPending++;
    }
  });

  document.getElementById('sumEat').textContent = countEat;
  document.getElementById('sumSkip').textContent = countSkip;
  document.getElementById('sumPending').textContent = countPending;

  // 2. Render My Response Buttons
  const myResponse = appState.responses[`${today}_${currentUser.id}`];
  const myStatus = myResponse ? myResponse.status : 'S-0';
  
  ['S-1', 'S-2', 'S-3', 'S-4'].forEach(sCode => {
    const codeTag = sCode.toLowerCase().replace('-', '');
    const btn = document.getElementById(`btn-${codeTag}`);
    if (btn) {
      btn.className = 'status-btn';
      if (myStatus === sCode) {
        btn.classList.add(`selected-${codeTag}`);
      }
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
      etaInput.value = (myResponse && myResponse.eta_time) ? myResponse.eta_time : '20:00';
    } else {
      etaGroup.style.display = 'none';
    }
    noteInput.value = (myResponse && myResponse.note) ? myResponse.note : '';
  } else {
    extraOptions.style.display = 'none';
  }

  // 3. Render Family Member Cards (FR-02 & FR-04)
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
    if (statusKey === 'S-3' && res && res.eta_time) {
      statusLabelText += ` (${res.eta_time}頃)`;
    }

    let noteHtml = '';
    if (res && res.note) {
      noteHtml = `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">💬 "${escapeHtml(res.note)}"</div>`;
    }

    let autoTagHtml = '';
    if (res && res.source === 'default') {
      autoTagHtml = `<span class="auto-tag">(自動)</span>`;
    } else if (res && res.source === 'proxy') {
      autoTagHtml = `<span class="auto-tag">(代理)</span>`;
    }

    let actionBtnHtml = '';
    if (isUnanswered && !isCurrentUser) {
      actionBtnHtml = `<button class="poke-btn" onclick="pokeMember('${u.id}', '${u.name}')">👉 つつく</button>`;
    } else if (isOwner && !isCurrentUser) {
      actionBtnHtml = `<button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;" onclick="openProxyModal('${u.id}')">✏️ 代理入力</button>`;
    }

    card.innerHTML = `
      <div class="member-info">
        <div class="avatar">${u.avatar}</div>
        <div class="member-details">
          <div class="member-name">
            <span>${escapeHtml(u.name)} ${isCurrentUser ? '(あなた)' : ''}</span>
            ${autoTagHtml}
          </div>
          <div class="update-time">
            ${res ? `最終更新: ${res.updated_at}` : '未登録'}
          </div>
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

// --- Submit User Status (FR-01) ---
function submitStatus(statusCode) {
  const today = getTodayStr();
  const user = getCurrentUser();
  const key = `${today}_${user.id}`;
  
  const nowTimeStr = getCurrentTimeStr();
  
  const newResponse = {
    status: statusCode,
    eta_time: statusCode === 'S-3' ? (document.getElementById('etaInput').value || '20:00') : '',
    note: document.getElementById('noteInput').value || '',
    source: 'manual',
    updated_at: nowTimeStr
  };

  appState.responses[key] = newResponse;
  saveState();
  renderHomeTab();

  // FR-10: Check if updated after deadline time
  const deadline = appState.group.deadline_time || '17:00';
  if (nowTimeStr > deadline) {
    const cfg = STATUS_CONFIG[statusCode];
    showToast(`⚠️ 締切後の変更: ${user.name}さんが『${cfg.label}』に変更しました (${nowTimeStr})`, 'warning');
  } else {
    showToast(`✅ 夕食の予定を「${STATUS_CONFIG[statusCode].label}」に更新しました！`, 'info');
  }
}

function saveExtraDetails() {
  const today = getTodayStr();
  const user = getCurrentUser();
  const key = `${today}_${user.id}`;
  
  if (appState.responses[key]) {
    appState.responses[key].eta_time = document.getElementById('etaInput').value;
    appState.responses[key].note = document.getElementById('noteInput').value;
    appState.responses[key].updated_at = getCurrentTimeStr();
    saveState();
    renderHomeTab();
  }
}

// --- Poke Unanswered Member (FR-04, FR-06) ---
function pokeMember(userId, userName) {
  showToast(`🔔 ${userName}さんに夕食要否のリマインド（つつく）を送信しました！`, 'info');
}

// --- Proxy Input Modal (FR-11) ---
function openProxyModal(userId) {
  proxyTargetUserId = userId;
  const user = appState.users.find(u => u.id === userId);
  if (!user) return;
  
  document.getElementById('proxyMemberName').textContent = user.name;
  
  const today = getTodayStr();
  const existing = appState.responses[`${today}_${userId}`];
  
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
  const etaGroup = document.getElementById('proxyEtaGroup');
  if (status === 'S-3') {
    etaGroup.style.display = 'block';
  } else {
    etaGroup.style.display = 'none';
  }
}

function submitProxyStatus() {
  if (!proxyTargetUserId) return;
  
  const today = getTodayStr();
  const statusCode = document.getElementById('proxyStatusSelect').value;
  const targetUser = appState.users.find(u => u.id === proxyTargetUserId);

  appState.responses[`${today}_${proxyTargetUserId}`] = {
    status: statusCode,
    eta_time: statusCode === 'S-3' ? document.getElementById('proxyEtaInput').value : '',
    note: document.getElementById('proxyNoteInput').value || '',
    source: 'proxy',
    updated_at: getCurrentTimeStr()
  };

  saveState();
  closeProxyModal();
  renderHomeTab();
  showToast(`代理入力: ${targetUser.name}さんの回答を更新しました`, 'info');
}

// --- Week View Render (FR-08) ---
function renderWeekTab() {
  const table = document.getElementById('weekTable');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  trHead.innerHTML = `<th>メンバー</th>`;

  for (let i = 0; i < 7; i++) {
    const isToday = i === 0;
    trHead.innerHTML += `<th class="${isToday ? 'today' : ''}">${getFormattedDisplayDate(i)}</th>`;
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  appState.users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 800; text-align: left;">
        ${u.avatar} ${escapeHtml(u.name)}
      </td>
    `;

    for (let i = 0; i < 7; i++) {
      const dateStr = getTodayStr(i);
      const res = appState.responses[`${dateStr}_${u.id}`];
      const sCode = res ? res.status : 'S-0';
      const cfg = STATUS_CONFIG[sCode];

      tr.innerHTML += `
        <td>
          <div class="matrix-cell status-badge ${cfg.bgClass}">
            ${cfg.icon} ${cfg.text}
          </div>
        </td>
      `;
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

// --- Default Schedule Render & Save (FR-09) ---
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
    const currentStatus = userDefaults[dayIdx] || 'S-1';
    const row = document.createElement('div');
    row.className = 'day-row';
    
    row.innerHTML = `
      <div class="day-name">毎週${dayName}曜</div>
      <select class="input-select" style="width: auto; flex: 1;" id="def-day-${dayIdx}">
        <option value="S-1" ${currentStatus === 'S-1' ? 'selected' : ''}>🍚 食べる</option>
        <option value="S-2" ${currentStatus === 'S-2' ? 'selected' : ''}>🙅‍♂️ 食べない</option>
        <option value="S-3" ${currentStatus === 'S-3' ? 'selected' : ''}>🌙 遅れて食べる</option>
        <option value="S-4" ${currentStatus === 'S-4' ? 'selected' : ''}>🍳 自分で用意する</option>
      </select>
    `;
    rowsContainer.appendChild(row);
  });
}

function saveDefaultSchedule() {
  const userId = document.getElementById('defaultUserSelect').value;
  if (!appState.defaults[userId]) appState.defaults[userId] = {};

  for (let i = 0; i < 7; i++) {
    const val = document.getElementById(`def-day-${i}`).value;
    appState.defaults[userId][i] = val;
  }

  saveState();
  showToast('💾 曜日別デフォルト設定を保存しました！', 'info');
}

// --- Render Family Members Tab (UI-05, FR-05) ---
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
          <div class="update-time">${u.role === 'owner' ? '👑 調理担当 (管理者)' : '👤 メンバー'}</div>
        </div>
      </div>
      <div>
        ${u.role !== 'owner' ? `<button class="btn btn-secondary" style="font-size: 11px; color: var(--status-s2-text);" onclick="removeMember('${u.id}')">削除</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

function showInviteModal() {
  document.getElementById('inviteModal').classList.add('active');
}

function closeInviteModal() {
  document.getElementById('inviteModal').classList.remove('active');
}

function copyInviteLink() {
  const currentUrl = window.location.href;
  navigator.clipboard.writeText(currentUrl);
  showToast('📋 WebアプリURLをクリップボードにコピーしました！', 'info');
}

function showAddMemberModal() {
  document.getElementById('addMemberModal').classList.add('active');
}

function closeAddMemberModal() {
  document.getElementById('addMemberModal').classList.remove('active');
}

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
  
  saveState();
  closeAddMemberModal();
  setupSimulationUserSelect();
  renderFamilyTab();
  showToast(`➕ ${name}さんを追加しました！`, 'info');
}

function removeMember(userId) {
  if (confirm('このメンバーをグループから削除しますか？')) {
    appState.users = appState.users.filter(u => u.id !== userId);
    saveState();
    setupSimulationUserSelect();
    renderFamilyTab();
    showToast('メンバーを削除しました', 'info');
  }
}

// --- Settings Page Operations ---
function saveGroupSettings() {
  appState.group.name = document.getElementById('settingsGroupName').value;
  appState.group.deadline_time = document.getElementById('settingsDeadlineTime').value;
  appState.group.reminder_time = document.getElementById('settingsReminderTime').value;

  saveState();
  updateHeaderDateBanner();
  showToast('💾 グループ設定を更新しました！', 'info');
}

// --- Test Push Notification Trigger Buttons (FR-06 & FR-07) ---
function triggerReminderNotification() {
  const today = getTodayStr();
  const unanswered = appState.users.filter(u => !appState.responses[`${today}_${u.id}`] || appState.responses[`${today}_${u.id}`].status === 'S-0');
  
  if (unanswered.length === 0) {
    showToast('🔔 15:00 リマインド: 全員が回答済みのため送信されませんでした', 'info');
  } else {
    const names = unanswered.map(u => u.name).join('さん, ') + 'さん';
    showToast(`🔔 [15:00 自動リマインド] ${names}へ「今夜の夕食要否を教えてね！」の通知を送信しました`, 'info');
  }
}

function triggerDeadlineSummaryNotification() {
  const today = getTodayStr();
  let eat = 0, skip = 0, pending = 0;

  appState.users.forEach(u => {
    const s = appState.responses[`${today}_${u.id}`] ? appState.responses[`${today}_${u.id}`].status : 'S-0';
    if (s === 'S-1' || s === 'S-3') eat++;
    else if (s === 'S-2' || s === 'S-4') skip++;
    else pending++;
  });

  const cook = appState.users.find(u => u.role === 'owner') || appState.users[0];
  showToast(`⏰ [17:00 締切サマリ] ${cook.name}さんへ通知: 本日の夕食: ${eat}名 (食べる), ${skip}名 (不要), 未回答: ${pending}名`, 'warning');
}

// --- History View Render (FR-14) ---
function renderHistoryTab() {
  const container = document.getElementById('historyContainer');
  container.innerHTML = '';

  for (let i = 1; i <= 5; i++) {
    const dateStr = getFormattedDisplayDate(-i);
    const item = document.createElement('div');
    item.className = 'history-item';
    
    item.innerHTML = `
      <div>
        <div class="history-date">📅 ${dateStr}</div>
        <div class="history-stats">全メンバー回答済み (食べる 3名 / 食べない 1名)</div>
      </div>
      <div style="color: var(--secondary); font-weight: 800; font-size: 13px;">確定</div>
    `;
    container.appendChild(item);
  }
}

// --- Tab Switching Logic ---
function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const activePane = document.getElementById(`tab-${tabId}`);
  const activeNav = document.getElementById(`nav-${tabId}`);

  if (activePane) activePane.classList.add('active');
  if (activeNav) activeNav.classList.add('active');

  if (tabId === 'home') renderHomeTab();
  else if (tabId === 'week') renderWeekTab();
  else if (tabId === 'default') renderDefaultTab();
  else if (tabId === 'family') renderFamilyTab();
  else if (tabId === 'history') renderHistoryTab();
}

// --- Toast Notification System ---
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

// --- Dark/Light Theme Toggle ---
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('bg_theme', newTheme);
  
  showToast(`🌙 テーマを「${newTheme === 'dark' ? 'ダーク' : 'ライト'}モード」に変更しました`, 'info');
}

// Helper: XSS Protection
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', initApp);
