// scripts/login.js
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

// 使用 stealth 插件
chromium.use(stealth());

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';

// 随机延迟函数，模拟真人操作
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

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
      `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
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

  // 启动浏览器，添加更多防检测参数
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
    ]
  });

  // 设置更真实的 User-Agent 和语言环境
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  const page = await context.newPage();
  const screenshot = (name) => `./${name}.png`;

  try {
    console.log('正在打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 90_000 });
    await randomDelay(2000, 5000);

    // 检查人机验证
    const humanCheckText = await page.locator('text=/Verify you are human|需要验证|安全检查|review the security/i').first();
    if (await humanCheckText.count()) {
      console.log('检测到 Cloudflare 验证，尝试等待并自动处理...');
      // 尝试等待验证框自动消失或点击（部分简单验证可自动过）
      await page.waitForTimeout(10000); 
      
      if (await humanCheckText.count()) {
        const sp = screenshot('01-human-check');
        await page.screenshot({ path: sp, fullPage: true });
        await notifyTelegram({ ok: false, stage: '打开登录页', msg: 'Cloudflare 拦截，请尝试手动运行或更换时间', screenshotPath: sp });
        process.exitCode = 2;
        return;
      }
    }

    // 2) 输入用户名密码
    console.log('正在输入登录信息...');
    const userInput = page.locator('input[name="username"]');
    const passInput = page.locator('input[name="password"]');
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    
    // 模拟真人打字速度
    await userInput.type(username, { delay: 100 });
    await randomDelay(500, 1500);
    await passInput.type(password, { delay: 100 });
    await randomDelay(1000, 2000);

    const loginBtn = page.locator('button[type="submit"]');
    await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    console.log('提交登录...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {}),
      loginBtn.click()
    ]);

    // 3) 登录结果
    await randomDelay(3000, 5000);
    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const successHint = await page.locator('text=/Dashboard|Logout|Sign out|控制台|面板/i').first().count();
    
    if (successHint > 0 || !url.includes('/auth/login')) {
      console.log('登录成功！');
      await notifyTelegram({ ok: true, stage: '登录成功', msg: `当前 URL：${url}`, screenshotPath: spAfter });

      // **进入服务器详情**
      console.log('进入服务器详情...');
      const serverLink = page.locator('a[href="/server/d769f389"]');
      await serverLink.waitFor({ state: 'visible', timeout: 20_000 });
      await serverLink.click();

      await page.waitForLoadState('networkidle', { timeout: 30_000 });
      await randomDelay(2000, 4000);
      
      // **点击 Console 菜单**
      console.log('打开控制台...');
      const consoleMenu = page.locator('a[href="/server/d769f389"].active');
      await consoleMenu.waitFor({ state: 'visible', timeout: 15_000 });
      await consoleMenu.click();

      await page.waitForLoadState('networkidle', { timeout: 10_000 });
      await randomDelay(3000, 5000);

      // **点击 Restart 按钮**
      console.log('执行重启操作...');
      const restartBtn = page.locator('button:has-text("Restart")');
      await restartBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await restartBtn.click();
      await notifyTelegram({ ok: true, stage: '点击 Restart', msg: 'VPS 正在重启' });

      await page.waitForTimeout(15000);

      // **输入命令**
      const commandInput = page.locator('input[placeholder="Type a command..."]');
      await commandInput.waitFor({ state: 'visible', timeout: 20_000 });
      await commandInput.type('working properly', { delay: 50 });
      await commandInput.press('Enter');

      await page.waitForTimeout(5000);

      const spCommand = screenshot('05-command-executed');
      await page.screenshot({ path: spCommand, fullPage: true });
      await notifyTelegram({ ok: true, stage: '命令执行完成', msg: '操作已全部完成', screenshotPath: spCommand });

      process.exitCode = 0;
      return;
    }

    // 登录失败处理
    console.log('登录似乎失败了。');
    const errorMsgNode = page.locator('text=/Invalid|incorrect|错误|失败|无效/i');
    const hasError = await errorMsgNode.count();
    const errorMsg = hasError ? await errorMsgNode.first().innerText().catch(() => '') : '';
    await notifyTelegram({
      ok: false,
      stage: '登录失败',
      msg: errorMsg ? `错误信息：${errorMsg}` : '仍在登录页，可能被拦截',
      screenshotPath: spAfter
    });
    process.exitCode = 1;
  } catch (e) {
    console.error('发生异常:', e);
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    await notifyTelegram({ ok: false, stage: '异常', msg: e?.message || String(e), screenshotPath: fs.existsSync(sp) ? sp : undefined });
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
