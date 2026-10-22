/**
 * 邮箱监听器：走邮箱官方 IMAP 协议收"学习通通知"，只读、免费、断线自愈。
 * fetchMail 可注入：生产用 imapflow，测试注入假邮件——解析/落库/队列逻辑同一套。
 */
import { ImapFlow } from 'imapflow';
import simpleParser from 'mailparser';
import { looksLikeXxt, parseXxtNotice } from './xuexitong.js';

export const IMAP_HOSTS = {
  'QQ 邮箱': { host: 'imap.qq.com', port: 993 },
  '163 邮箱': { host: 'imap.163.com', port: 993 },
  '126 邮箱': { host: 'imap.126.com', port: 993 },
};

/** 生产 IMAP 拉取：返回本轮新邮件（学习通相关的），并推进 UID 水位线 */
export function makeImapFetcher(log) {
  return async function fetchMail({ host, port = 993, user, authCode, lastUid = 0 }) {
    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass: authCode },
      logger: false,
    });
    const out = [];
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';
        let uidNext = lastUid;
        for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true }, { changedSince: null })) {
          const uid = Number(msg.uid) || 0;
          if (uid > uidNext) uidNext = uid;
          if (uid <= lastUid) continue;
          try {
            const parsed = await simpleParser(msg.source);
            out.push({
              uid,
              from: `${parsed.from?.text || ''}`,
              subject: parsed.subject || '',
              text: (parsed.text || '').slice(0, 4000),
            });
          } catch {
            // 单封解析失败不影响其它
          }
        }
        return { mails: out, maxUid: uidNext };
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          /* 已断开 */
        }
      }
    }
  };
}

/**
 * 监听引擎：poll 一轮（永不向上抛错），新邮件 → 解析 → 分发。
 * @param cfg { enabled, host, user, authCode, lastUid }
 * @param deps { fetchMail, onNotice(n), log }
 */
export async function pollMailbox(cfg, deps) {
  const { fetchMail, onNotice, log = () => {} } = deps;
  if (!cfg || !cfg.enabled) return { ok: true, skipped: 'off', count: 0 };
  if (!cfg.user || !cfg.authCode || !cfg.host) return { ok: false, error: '没有配置完整（邮箱/授权码/服务器）', count: 0 };
  try {
    const { mails, maxUid } = await fetchMail(cfg);
    let count = 0;
    for (const m of mails || []) {
      if (!looksLikeXxt(m.from, m.subject, m.text)) continue;
      try {
        await onNotice(parseXxtNotice(m));
        count += 1;
      } catch (e) {
        log('学习通通知处理失败（跳过这一封）：' + (e && e.message ? e.message : e));
      }
    }
    return { ok: true, count, lastUid: maxUid ?? cfg.lastUid ?? 0 };
  } catch (e) {
    // 网络/登录错误只记录，不崩——下一轮继续
    return { ok: false, error: String((e && e.message) || '邮箱连接失败'), count: 0 };
  }
}
