/**
 * CarClip 導線監視
 *
 * 実ブラウザ（Chromium）でLPを開き、JavaScriptを実行したうえで
 *   1. HTTPステータス
 *   2. 未捕捉のJSエラー（今回の "$ is not a function" を検出する本体）
 *   3. 必須テキストの存在
 *   4. 商品リンクの本数と、その疎通（サンプル抽出）
 *   5. JS生成セレクターの実操作（クリックして商品リンクが出るか）
 *   6. カート投入が成立するか
 * を検査し、異常があれば Resend でメール通知します。
 *
 * 注文は一切確定しません。カート投入はセッション上の操作のみです。
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG = JSON.parse(readFileSync('./config.json', 'utf8'));
const STATE_PATH = './state.json';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FORCE_MAIL = process.env.FORCE_MAIL === '1';
const MAIL_MODE = process.env.MAIL_MODE || 'manual'; // 'digest' | 'manual'

const nowJst = () =>
  new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

/** JSエラーのうち、売上導線に無関係で無視してよいもの */
const IGNORED_ERROR_PATTERNS = [
  /googletagmanager/i,
  /google-analytics/i,
  /doubleclick/i,
  /facebook\.net/i,
  /ERR_BLOCKED_BY_CLIENT/i,
];

const isIgnorable = (msg) => IGNORED_ERROR_PATTERNS.some((re) => re.test(msg));

/* ------------------------------------------------------------------ */
/* 1ページ分の検査                                                      */
/* ------------------------------------------------------------------ */
async function checkPage(browser, pageDef) {
  const result = {
    name: pageDef.name,
    url: pageDef.url,
    ok: true,
    problems: [],
    notes: [],
  };

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 CarClipMonitor/1.0',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const jsErrors = [];
  page.on('pageerror', (err) => {
    const m = String(err && err.message ? err.message : err);
    if (!isIgnorable(m)) jsErrors.push(m);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const m = msg.text();
    if (!isIgnorable(m)) jsErrors.push(m);
  });

  try {
    /* --- 1. HTTPステータス --- */
    const resp = await page.goto(pageDef.url, {
      waitUntil: 'networkidle',
      timeout: CONFIG.options.timeoutMs,
    });
    const status = resp ? resp.status() : 0;
    result.notes.push(`HTTP ${status}`);
    if (status !== 200) {
      result.ok = false;
      result.problems.push(`HTTPステータスが ${status} です（正常は200）`);
      await context.close();
      return result;
    }

    /* --- 2. 必須テキスト --- */
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    for (const t of pageDef.mustContainText || []) {
      if (!bodyText.includes(t)) {
        result.ok = false;
        result.problems.push(`必須テキスト「${t}」がページ上に見つかりません`);
      }
    }

    /* --- 3. 商品リンクの本数 --- */
    let productLinks = [];
    if (pageDef.productLinkPattern) {
      const re = new RegExp(pageDef.productLinkPattern);
      const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)
      );
      productLinks = [...new Set(hrefs.filter((h) => re.test(h)))];
      result.notes.push(`商品リンク ${productLinks.length}本`);

      if (productLinks.length < (pageDef.minProductLinks || 0)) {
        result.ok = false;
        result.problems.push(
          `商品リンクが ${productLinks.length}本しかありません` +
            `（最低 ${pageDef.minProductLinks}本を期待）。` +
            `LPから商品ページへ辿り着けなくなっている可能性があります`
        );
      }
    }

    /* --- 4. JS生成セレクターの実操作 --- */
    if (pageDef.interactive && pageDef.interactive.type === 'clickThrough') {
      const before = await page.evaluate(
        () => document.querySelectorAll('a[href]').length
      );
      let clicked = 0;

      for (const label of pageDef.interactive.stepTexts || []) {
        const target = page
          .locator(
            `button:has-text("${label}"), a:has-text("${label}"), ` +
              `label:has-text("${label}"), li:has-text("${label}"), ` +
              `[class*="btn"]:has-text("${label}")`
          )
          .first();
        try {
          await target.click({ timeout: 8000 });
          clicked += 1;
          await page.waitForTimeout(900);
        } catch {
          result.ok = false;
          result.problems.push(
            `セレクターの選択肢「${label}」をクリックできませんでした。` +
              `JavaScriptが停止して選択フォームが機能していない可能性があります`
          );
          break;
        }
      }

      if (clicked === (pageDef.interactive.stepTexts || []).length) {
        const after = await page.evaluate(
          () => document.querySelectorAll('a[href]').length
        );
        const hasReal = await page.evaluate(() => {
          const as = Array.from(document.querySelectorAll('a[href]'));
          return as.some(
            (a) =>
              /car-clip\.com\/[a-z0-9-]+\/?$/.test(a.href) &&
              !a.getAttribute('href').endsWith('#') &&
              a.offsetParent !== null
          );
        });
        result.notes.push(`操作後リンク数 ${before}→${after}`);
        if (!hasReal) {
          result.ok = false;
          result.problems.push(
            'セレクターを最後まで操作しましたが、商品ページへの実リンクが生成されませんでした'
          );
        }
      }
    }

    /* --- 5. JSエラー --- */
    if (jsErrors.length > 0) {
      const uniq = [...new Set(jsErrors)];
      const fatal = uniq.filter((m) => /is not a function|is not defined|Cannot read/i.test(m));
      if (fatal.length > 0) {
        result.ok = false;
        result.problems.push(
          `致命的なJavaScriptエラー：\n    - ${fatal.slice(0, 5).join('\n    - ')}`
        );
      } else {
        result.notes.push(`軽微なJSエラー ${uniq.length}件`);
      }
    }

    /* --- 6. 商品リンクの疎通確認 --- */
    if (productLinks.length > 0) {
      const n = Math.min(CONFIG.options.productLinkSampleSize, productLinks.length);
      const sample = [...productLinks].sort(() => Math.random() - 0.5).slice(0, n);
      for (const link of sample) {
        try {
          const r = await context.request.get(link, { timeout: 20000 });
          if (r.status() !== 200) {
            result.ok = false;
            result.problems.push(`商品リンクが HTTP ${r.status()}：${link}`);
          }
        } catch (e) {
          result.ok = false;
          result.problems.push(`商品リンクに接続できません：${link}`);
        }
      }
      result.notes.push(`商品リンク疎通 ${n}本確認`);
    }
  } catch (e) {
    result.ok = false;
    result.problems.push(`ページを開けませんでした：${String(e).slice(0, 300)}`);
  } finally {
    await context.close();
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* カート投入テスト                                                     */
/* ------------------------------------------------------------------ */
async function checkCart(browser) {
  const cfg = CONFIG.cartCheck;
  const result = {
    name: 'カート投入テスト',
    url: cfg.productUrl,
    ok: true,
    problems: [],
    notes: [],
  };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    const resp = await page.goto(cfg.productUrl, {
      waitUntil: 'networkidle',
      timeout: CONFIG.options.timeoutMs,
    });
    if (!resp || resp.status() !== 200) {
      result.ok = false;
      result.problems.push(`商品ページが HTTP ${resp ? resp.status() : 0} です`);
      await context.close();
      return result;
    }

    /* Welcart のカート投入ボタン候補を順に試す */
    const candidates = [
      'input[name="usces_cart"]',
      'button[name="usces_cart"]',
      '.skubutton',
      'input.skubutton',
      'input[value*="カートに入れる"]',
      'button:has-text("カートに入れる")',
    ];

    let matched = null;
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        matched = sel;
        break;
      }
    }

    if (!matched) {
      result.ok = false;
      result.problems.push(
        'カート投入ボタンが商品ページ上に見つかりません。' +
          'ボタンが消えている、またはWelcartのテンプレートが壊れている可能性があります'
      );
      await context.close();
      return result;
    }
    result.notes.push(`ボタン検出：${matched}`);

    await page.locator(matched).first().click({ timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.options.timeoutMs });

    /* カートページを開いて中身を確認 */
    await page.goto(cfg.cartUrl, {
      waitUntil: 'networkidle',
      timeout: CONFIG.options.timeoutMs,
    });
    const cartText = await page.evaluate(() => document.body.innerText || '');

    const looksEmpty =
      /カートに商品がありません|商品がありません|カートは空/.test(cartText);
    const hasTotal = /(合計|小計|お支払い)/.test(cartText);

    if (looksEmpty || !hasTotal) {
      result.ok = false;
      result.problems.push(
        'カートに商品を入れたのに、カートページに商品が入っていません。' +
          '購入導線が途中で切れています'
      );
    } else {
      result.notes.push('カートに商品が入ることを確認');
    }
  } catch (e) {
    result.ok = false;
    result.problems.push(`カートテスト中にエラー：${String(e).slice(0, 300)}`);
  } finally {
    await context.close();
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* メール送信                                                           */
/* ------------------------------------------------------------------ */
async function sendMail(subject, html) {
  if (!RESEND_API_KEY) {
    console.log('[warn] RESEND_API_KEY が未設定のためメールは送信しません');
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: CONFIG.alert.from,
      to: CONFIG.alert.to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    console.error('[error] メール送信失敗:', res.status, await res.text());
    return false;
  }
  console.log('[ok] メール送信完了');
  return true;
}

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function buildHtml(results, headline) {
  const rows = results
    .map((r) => {
      const badge = r.ok
        ? '<span style="color:#0a7d32;font-weight:700">正常</span>'
        : '<span style="color:#c0392b;font-weight:700">異常</span>';
      const probs = r.problems.length
        ? `<ul style="margin:6px 0 0;padding-left:18px;color:#c0392b">${r.problems
            .map((p) => `<li>${esc(p).replace(/\n/g, '<br>')}</li>`)
            .join('')}</ul>`
        : '';
      const notes = r.notes.length
        ? `<div style="color:#777;font-size:12px;margin-top:4px">${esc(
            r.notes.join(' / ')
          )}</div>`
        : '';
      return `<tr>
        <td style="padding:12px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap">${badge}</td>
        <td style="padding:12px;border-bottom:1px solid #eee">
          <div style="font-weight:600">${esc(r.name)}</div>
          <a href="${esc(r.url)}" style="font-size:12px;color:#2a6fdb">${esc(r.url)}</a>
          ${probs}${notes}
        </td>
      </tr>`;
    })
    .join('');

  return `<div style="font-family:-apple-system,'Hiragino Sans',sans-serif;max-width:680px">
    <h2 style="margin:0 0 4px">${esc(headline)}</h2>
    <div style="color:#777;font-size:12px;margin-bottom:16px">検査日時：${esc(nowJst())}（日本時間）</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
    <p style="color:#777;font-size:12px;margin-top:20px">
      このメールは carclip-monitor（GitHub Actions）が自動送信しています。<br>
      検査内容の変更は config.json を編集してください。
    </p>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* メイン                                                              */
/* ------------------------------------------------------------------ */
async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const results = [];

  for (const p of CONFIG.pages) {
    console.log(`検査中: ${p.name}`);
    results.push(await checkPage(browser, p));
  }
  if (CONFIG.cartCheck.enabled) {
    console.log('検査中: カート投入テスト');
    results.push(await checkCart(browser));
  }
  await browser.close();

  /* コンソール出力 */
  for (const r of results) {
    console.log(`\n[${r.ok ? 'OK ' : 'NG '}] ${r.name}`);
    r.problems.forEach((p) => console.log(`      ! ${p}`));
    if (r.notes.length) console.log(`      (${r.notes.join(' / ')})`);
  }

  const failing = results.filter((r) => !r.ok);
  const prev = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : { failingNames: [] };
  const prevFailing = prev.failingNames || [];
  const nowFailing = failing.map((r) => r.name);

  const newlyBroken = nowFailing.filter((n) => !prevFailing.includes(n));
  const recovered = prevFailing.filter((n) => !nowFailing.includes(n));

  const modeLabel = MAIL_MODE === 'digest' ? '日次レポート' : '手動実行レポート';

  let mailed = false;
  if (newlyBroken.length > 0 || FORCE_MAIL) {
    let subject;
    let headline;

    if (newlyBroken.length > 0) {
      subject = `${CONFIG.alert.subjectPrefix} 異常検知 ${nowFailing.length}件（新規${newlyBroken.length}件）`;
      headline = '購入導線に異常を検知しました';
    } else if (failing.length > 0) {
      subject = `${CONFIG.alert.subjectPrefix} ${modeLabel}（異常${failing.length}件・継続中）`;
      headline = `${modeLabel}：異常が続いています`;
    } else {
      subject = `${CONFIG.alert.subjectPrefix} ${modeLabel}（すべて正常）`;
      headline = `${modeLabel}：すべて正常です`;
    }

    mailed = await sendMail(subject, buildHtml(results, headline));
  } else if (recovered.length > 0 && CONFIG.options.sendRecoveryMail) {
    mailed = await sendMail(
      `${CONFIG.alert.subjectPrefix} 復旧しました（${recovered.join('、')}）`,
      buildHtml(results, '異常が解消しました')
    );
  } else if (failing.length === 0) {
    console.log('すべて正常。前回も正常のためメールは送りません。');
  } else {
    console.log('異常継続中（通知済みのため再送しません）。');
  }

  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      { updatedAt: nowJst(), failingNames: nowFailing, mailed },
      null,
      2
    ) + '\n'
  );

  /* 異常があってもワークフローは落とさない（メールが本体のため） */
  console.log(`\n完了: 異常 ${failing.length}件 / 全 ${results.length}件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
