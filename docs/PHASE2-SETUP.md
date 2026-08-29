# メール通知機能（フェーズ2） セットアップ手順書

本アプリ「ばんごはん、いる？」の定時メールリマインドおよび締切サマリ通知（GitHub Actions + Brevo 連携）の初期設定手順です。

---

## 1. Brevo（旧 Sendinblue）のアカウント作成とAPIキー取得

1. [Brevo (https://www.brevo.com/)](https://www.brevo.com/) にアクセスし、無料アカウントを作成します。
2. 送信元メールアドレス（例: ご自身のメールアドレス）を Brevo の「Senders & IP」画面で登録し、認証を完了させます。
3. アカウントメニューの **SMTP & API** から APIキー (v3) を生成・コピーします。

---

## 2. GitHub Secrets の設定

GitHub リポジトリの **Settings > Secrets and variables > Actions** に移動し、以下の Repository Secrets を登録します。

| Secret 名 | 設定値の概要 | 必須 / 任意 |
|---|---|---|
| `BREVO_API_KEY` | Brevo で取得した API キー (`xkeysib-...`) | **必須** |
| `SENDER_EMAIL` | Brevo で認証済みの送信元メールアドレス | **必須** |
| `KVDB_BUCKET` | KVdb のバケット ID (`AeVidZgwuAzpw3ipmY5xhR`) | **必須** |
| `KVDB_KEY` | データのキー名 (`group_BINGO2026`) | 任意 |
| `SENDER_NAME` | 送信者名 (`ばんごはん、いる？`) | 任意 |
| `MEMBER_EMAILS` | メンバーのメールアドレスJSONマップ (例: `{"u1":"a@example.com","u2":"b@example.com"}`) | 任意 (推奨) |
| `APP_URL` | アプリの公開URL (`https://y-y-2005.github.io/bangohan-app/`) | 任意 |

---

## 3. 動作確認

1. リポジトリの **Actions** タブを開きます。
2. **Dinner Attendance Reminder & Summary** ワークフローを選択し、**Run workflow** ボタンを押して手動実行します。
3. 実行ログを確認し、エラーなく正常終了（`完了`）することを確認します。
