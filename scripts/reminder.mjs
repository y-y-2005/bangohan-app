/**
 * ばんごはん、いる？ — 夕食リマインド / 締切サマリ 送信スクリプト
 *
 * GitHub Actions から定時実行される。ブラウザ側では動かない。
 * 依存パッケージなし（Node 18+ のグローバル fetch のみ使用）。
 *
 * 環境変数（すべて GitHub Secrets / env 経由）:
 *   BREVO_API_KEY   必須  Brevo の API キー
 *   SENDER_EMAIL    必須  送信元アドレス（Brevo で認証済みのもの）
 *   SENDER_NAME     任意  送信者名（既定: ばんごはん、いる？）
 *   KVDB_BUCKET     必須  KVdb のバケットID
 *   KVDB_KEY        任意  データのキー名（既定: group_BINGO2026）
 *   MEMBER_EMAILS   任意  {"u1":"a@example.com","u2":"b@example.com"} 形式のJSON
 *                         指定した場合、KVdb 側の email より優先される（推奨）
 *   APP_URL         任意  アプリのURL。メール本文にリンクとして入れる
 *   DRY_RUN         任意  "true" ならメールを送信せず内容を出力するだけ
 */

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const SENDER_NAME = process.env.SENDER_NAME || 'ばんごはん、いる？';
const KVDB_BUCKET = process.env.KVDB_BUCKET;
const KVDB_KEY = process.env.KVDB_KEY || 'group_BINGO2026';
const APP_URL = process.env.APP_URL || '';
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const KV_BASE = `https://kvdb.io/${KVDB_BUCKET}`;

// --- JST の現在時刻を取得（実行環境のTZに依存しない） ---
function jstNow() {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  const hour = g('hour') === '24' ? '00' : g('hour');
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    time: `${hour}:${g('minute')}`,
    label: `${Number(g('month'))}月${Number(g('day'))}日`
  };
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

async function kvGet(key) {
  const res = await fetch(`${KV_BASE}/${key}?_=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KVdb GET ${key} failed: HTTP ${res.status}`);
  return await res.text();
}

async function kvSet(key, value) {
  // Content-Type は付けない（アプリ側と挙動を揃えるため）
  const res = await fetch(`${KV_BASE}/${key}`, { method: 'POST', body: value });
  if (!res.ok) throw new Error(`KVdb POST ${key} failed: HTTP ${res.status}`);
}

// --- 宛先の解決。Secret を優先し、無ければ KVdb 側の email を使う ---
function resolveEmails(users) {
  const map = {};
  if (process.env.MEMBER_EMAILS) {
    try {
      Object.assign(map, JSON.parse(process.env.MEMBER_EMAILS));
    } catch (e) {
      fail('MEMBER_EMAILS のJSONが不正です: ' + e.message);
    }
  }
  return users.map(u => {
    const addr = map[u.id] || u.email || '';
    return { ...u, resolvedEmail: String(addr).trim() };
  });
}

const VALID = a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a);

async function sendMail(to, subject, textBody) {
  if (DRY_RUN) {
    console.log('--- DRY RUN ---');
    console.log('To: ' + to.map(t => t.email).join(', '));
    console.log('Subject: ' + subject);
    console.log(textBody);
    return { dryRun: true };
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: to,
      subject: subject,
      textContent: textBody
    })
  });

  const body = await res.text();
  if (!res.ok) {
    // APIキーは絶対にログへ出さない
    throw new Error(`Brevo送信失敗: HTTP ${res.status} / ${body.slice(0, 300)}`);
  }
  return JSON.parse(body || '{}');
}

// --- 未確定判定 ---
// source が 'default' の回答は曜日別デフォルトの自動反映であり、
// 本人が確認したわけではないため「未確定」として催促の対象に含める。
function isUnconfirmed(res) {
  if (!res) return true;
  if (res.status === 'S-0') return true;
  if (res.source === 'default') return true;
  return false;
}

const STATUS_LABEL = {
  'S-1': '食べる',
  'S-2': '食べない',
  'S-3': '遅れて食べる',
  'S-4': '自分で用意する'
};

async function main() {
  for (const [k, v] of Object.entries({ BREVO_API_KEY, SENDER_EMAIL, KVDB_BUCKET })) {
    if (!v) fail(`環境変数 ${k} が未設定です`);
  }

  const now = jstNow();
  console.log(`JST ${now.date} ${now.time} に起動`);

  const raw = await kvGet(KVDB_KEY);
  if (!raw) fail(`KVdb にデータがありません (key: ${KVDB_KEY})`);

  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    fail('KVdb のデータをJSONとして解釈できません: ' + e.message);
  }

  const group = state.group || {};
  const users = resolveEmails(state.users || []);
  const responses = state.responses || {};

  const reminderTime = group.reminder_time || '15:00';
  const deadlineTime = group.deadline_time || '17:00';
  const groupName = group.name || '家族';

  const unconfirmed = users.filter(u => isUnconfirmed(responses[`${now.date}_${u.id}`]));

  // ---------- 1. リマインド ----------
  const remindFlag = `sent_reminder_${now.date}`;
  if (now.time >= reminderTime && now.time < deadlineTime) {
    if (await kvGet(remindFlag)) {
      console.log('リマインドは本日送信済み。スキップします。');
    } else if (unconfirmed.length === 0) {
      console.log('全員が回答済みのため、リマインドは送信しません。');
      await kvSet(remindFlag, 'skipped_all_answered');
    } else {
      const targets = unconfirmed.filter(u => VALID(u.resolvedEmail));
      const skipped = unconfirmed.filter(u => !VALID(u.resolvedEmail));
      if (skipped.length) {
        console.log('メール未登録のためスキップ: ' + skipped.map(u => u.name).join(', '));
      }

      if (targets.length === 0) {
        console.log('宛先が1件もありません。');
      } else {
        const body = [
          `${now.label} の夕食の予定がまだ確定していません。`,
          '',
          `締切: ${deadlineTime}`,
          `未確定: ${unconfirmed.map(u => u.name).join('、')}`,
          '',
          'アプリを開いて、今日の予定を1タップで登録してください。',
          APP_URL,
          '',
          `-- ${groupName} / ${SENDER_NAME}`
        ].join('\n');

        await sendMail(
          targets.map(u => ({ email: u.resolvedEmail, name: u.name })),
          `【${groupName}】今日の夕食、いる？（締切 ${deadlineTime}）`,
          body
        );
        console.log(`リマインドを ${targets.length} 名に送信しました。`);
        await kvSet(remindFlag, String(Date.now()));
      }
    }
  } else {
    console.log(`リマインド時間帯外（${reminderTime}〜${deadlineTime}）。`);
  }

  // ---------- 2. 締切サマリ（調理担当者宛） ----------
  const summaryFlag = `sent_summary_${now.date}`;
  if (now.time >= deadlineTime) {
    if (await kvGet(summaryFlag)) {
      console.log('締切サマリは本日送信済み。スキップします。');
    } else {
      const owner = users.find(u => u.role === 'owner');
      if (!owner || !VALID(owner.resolvedEmail)) {
        console.log('調理担当者のメールアドレスが未登録のため、サマリは送信しません。');
      } else {
        const lines = users.map(u => {
          const r = responses[`${now.date}_${u.id}`];
          if (!r || r.status === 'S-0') return `  ${u.name}: 未回答`;
          const label = STATUS_LABEL[r.status] || r.status;
          const eta = r.status === 'S-3' && r.eta_time ? `（${r.eta_time}頃）` : '';
          const auto = r.source === 'default' ? ' ※自動反映' : '';
          const note = r.note ? ` / ${r.note}` : '';
          return `  ${u.name}: ${label}${eta}${auto}${note}`;
        });

        const eat = users.filter(u => {
          const r = responses[`${now.date}_${u.id}`];
          return r && (r.status === 'S-1' || r.status === 'S-3');
        }).length;

        const body = [
          `${now.label} の夕食は ${eat}名 です。`,
          unconfirmed.length ? `（うち未確定 ${unconfirmed.length}名。確定値ではありません）` : '（全員確定済み）',
          '',
          '内訳:',
          ...lines,
          '',
          APP_URL,
          '',
          `-- ${groupName} / ${SENDER_NAME}`
        ].join('\n');

        await sendMail(
          [{ email: owner.resolvedEmail, name: owner.name }],
          `【${groupName}】${now.label}の夕食: ${eat}名`,
          body
        );
        console.log('締切サマリを送信しました。');
        await kvSet(summaryFlag, String(Date.now()));
      }
    }
  } else {
    console.log(`締切前（${deadlineTime}）のため、サマリは送信しません。`);
  }

  console.log('完了');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
