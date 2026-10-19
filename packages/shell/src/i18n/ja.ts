// Japanese catalogue of the shell (NFR-07). Key = English source text, value = Japanese.
// STATUS: MACHINE-DRAFTED by Claude Code on 2026-10-19 — NEEDS REVIEW BY A NATIVE JAPANESE SPEAKER before it is used with
// sites or subjects in Japan (review note: docs/compliance/evidence/2026-10-19_NFR-07_a11y.md). Missing entries fall back
// to English.
import type { Catalogue } from '../i18n-core.ts';

export const SHELL_JA: Catalogue = {
  // app shell and footer
  'Skip to content': 'メインコンテンツへスキップ',
  'Main': 'メイン',
  'waiting': '件が待機中',
  'Page': 'ページ',
  'Copy the link to this page': 'このページのリンクをコピー',
  'link copied': 'リンクをコピーしました',
  'Language': '言語',
  // base components
  'value {v}, interim target {i}, final target {f}': '値 {v}、中間目標 {i}、最終目標 {f}',
  'no data': 'データなし',
  'Interim target {n}': '中間目標 {n}',
  'Final target {n}': '最終目標 {n}',
  'Everything is within target.': 'すべて目標範囲内です。',
  'Critical: ': '重大：',
  'Warning: ': '警告：',
  'Process': 'プロセス',
  'Signature': '署名',
  'Nothing here yet': 'まだ何もありません',
  'Table': '表',
  'Loading': '読み込み中',
  'Something went wrong': 'エラーが発生しました',
  // dialogs: signature (Part 11 / ERES) and reason for change
  'Cancel': 'キャンセル',
  'Signing…': '署名中…',
  'Meaning of this signature: {meaning}': 'この署名の意味：{meaning}',
  'review': 'レビュー',
  'approval': '承認',
  'Reason': '理由',
  'Recorded in the audit trail': '監査証跡に記録されます',
  'Password': 'パスワード',
  'Re-enter your password to sign': '署名するにはパスワードを再入力してください',
  'Authenticator code': '認証コード',
  '6-digit code from your authenticator app': '認証アプリに表示される6桁のコード',
  'Saving…': '保存中…',
  'Reason for change': '変更理由',
  // Suggest changes (UX-01)
  'Suggest changes': '変更を提案',
  'Suggest changes: number the components of this page and describe what should change': '変更を提案：このページの構成要素に番号を付け、変更内容を記入します',
  'Suggestion mode': '提案モード',
  'dialog': 'ダイアログ',
  'click a number to suggest a change': '番号をクリックして変更を提案',
  '{n} components': '構成要素 {n} 個',
  'Renumber (after opening a dialog or changing tab)': '番号を振り直す（ダイアログを開いた後やタブを切り替えた後）',
  'Renumber': '番号を振り直す',
  'Done': '完了',
  'Component {code}, {kind}': '構成要素 {code}（{kind}）',
  'Change': '変更',
  'Bug': '不具合',
  'New feature': '新機能',
  'Describe the change first.': '先に変更内容を記入してください。',
  'Suggest a change on {code}': '{code} への変更を提案',
  'Close': '閉じる',
  'Type of request': '依頼の種類',
  'What should change': '変更すべき内容',
  'What should change here? For example: add a column with the due date, sort by site, rename this button…':
    'ここで何を変更すべきですか？例：期日の列を追加する、施設で並べ替える、このボタンの名前を変える…',
  'Describe the screen, not patients: no personal or clinical data in the request.':
    '患者ではなく画面について記入してください。依頼に個人データや臨床データを含めないでください。',
  'Not sent': '未送信',
  'Sent — it is in {where} with code {code}. Pick another number or press Done.':
    '送信しました。{where} にコード {code} で登録されています。別の番号を選ぶか「完了」を押してください。',
  'Sending…': '送信中…',
  'Send suggestion': '提案を送信',
  'Open on {page}: {n}': '{page} の未対応：{n} 件',
  '{n} on this component': 'この構成要素に {n} 件',
};
