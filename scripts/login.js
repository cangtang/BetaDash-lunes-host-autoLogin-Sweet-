// scripts/login.js
import { chromium } from '@playwright/test';
import fs from 'fs';

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';

// Telegram 通知
async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log('[WARN] TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 未设置，跳过通知');
      return;
    }

    const text = [
      `🔔 Lunes 自动操作：${ok ? '✅ 成功' : '❌ 失败'}`,
      `阶段：${stage}`,
      msg ? `信息：${msg}` : '',
      `时间：${new Date().toISOString()}`
    ].filter(Boolean).join('\n');

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    // 如果有截图，再发图
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', `Lunes 自动操作截图（${stage}）`);
      form.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(photoUrl, { method: 'POST', body: form });
    }
  } catch (e) {
    console.log('[WARN] Telegram 通知失败：', e.message);
  }
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  const screenshot = (name) => `./${name}.png`;

  try {
    // 1) 打开登录页
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 检查人机验证
    const humanCheckText = await page.locator('text=/Verify you are human|需要验证|安全检查|review the security/i').first();
    if (await humanCheckText.count()) {
      const sp = screenshot('01-human-check');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyTelegram({ ok: false, stage: '打开登录页', msg: '检测到人机验证页面', screenshotPath: sp });
      process.exitCode = 2;
      return;
    }

    // 2) 输入用户名密码
    const userInput = page.locator('input[name="username"]');
    const passInput = page.locator('input[name="password"]');
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    await userInput.fill(username);
    await passInput.fill(password);

    const loginBtn = page.locator('button[type="submit"]');
    await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
      loginBtn.click({ timeout: 10_000 })
    ]);

    // 3) 登录结果截图
    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const successHint = await page.locator('text=/Dashboard|Logout|Sign out|控制台|面板/i').first().count();
    const stillOnLogin = /\/auth\/login/i.test(url);

    if (!stillOnLogin || successHint > 0) {
      await notifyTelegram({ ok: true, stage: '登录成功', msg: `当前 URL：${url}`, screenshotPath: spAfter });

      // **进入服务器详情**
      const serverLink = page.locator('a[href="/server/d769f389"]');
      await serverLink.waitFor({ state: 'visible', timeout: 20_000 });
      await serverLink.click({ timeout: 10_000 });

      await page.waitForLoadState('networkidle', { timeout: 30_000 });
      const spServer = screenshot('04-server-page');
      await page.screenshot({ path: spServer, fullPage: true });
      await notifyTelegram({ ok: true, stage: '进入服务器页面', msg: '已成功打开服务器详情', screenshotPath: spServer });

      // **点击 Console 菜单**
      const consoleMenu = page.locator('a[href="/server/d769f389"].active');
      await consoleMenu.waitFor({ state: 'visible', timeout: 15_000 });
      await consoleMenu.click({ timeout: 5_000 });

      await page.waitForLoadState('networkidle', { timeout: 10_000 });

      // **点击 Restart 按钮**
      const restartBtn = page.locator('button:has-text("Restart")');
      await restartBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await restartBtn.click();
      await notifyTelegram({ ok: true, stage: '点击 Restart', msg: 'VPS 正在重启' });

      // 等待 VPS 重启（约 10 秒）
      await page.waitForTimeout(10000);

      // **输入命令并回车**
      const commandInput = page.locator('input[placeholder="Type a command..."]');
      await commandInput.waitFor({ state: 'visible', timeout: 20_000 });
      await commandInput.fill('working properly');
      await commandInput.press('Enter');

      // 等待输出稳定
      await page.waitForTimeout(5000);

      // 截图并通知
      const spCommand = screenshot('05-command-executed');
      await page.screenshot({ path: spCommand, fullPage: true });
      await notifyTelegram({ ok: true, stage: '命令执行完成', msg: 'restart.sh 已执行', screenshotPath: spCommand });

      process.exitCode = 0;
      return;
    }

    // 登录失败处理
    const errorMsgNode = page.locator('text=/Invalid|incorrect|错误|失败|无效/i');
    const hasError = await errorMsgNode.count();
    const errorMsg = hasError ? await errorMsgNode.first().innerText().catch(() => '') : '';
    await notifyTelegram({
      ok: false,
      stage: '登录失败',
      msg: errorMsg ? `疑似失败（${errorMsg}）` : '仍在登录页',
      screenshotPath: spAfter
    });
    process.exitCode = 1;
  } catch (e) {
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    await notifyTelegram({ ok: false, stage: '异常', msg: e?.message || String(e), screenshotPath: fs.existsSync(sp) ? sp : undefined });
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
