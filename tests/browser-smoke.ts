import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

export async function browserSmoke(
  base: string,
  cookie: string,
  postId: number,
  image: Buffer,
) {
  const browser = await chromium.launch({ headless: true });
  const events: string[] = [];
  const errors: string[] = [];
  const violations: string[] = [];
  const context = await browser.newContext({ timezoneId: 'Europe/Stockholm' });
  await context.exposeBinding('recordTestEvent', (_source, name: string) =>
    events.push(name),
  );
  await context.exposeBinding(
    'recordTestViolation',
    (_source, directive: string) => violations.push(directive),
  );
  await context.addInitScript({
    content: `
    Object.defineProperty(navigator,'webdriver',{get:()=>false});
    document.addEventListener('securitypolicyviolation',event=>window.recordTestViolation(event.violatedDirective));
  `,
  });
  await context.route('https://analytics.sergionavarro.me/script.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'window.umami={track:(name)=>window.recordTestEvent(name)};',
    }),
  );
  await context.route('https://example.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: 'Isolated outbound-link fixture',
    }),
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      /content security policy|violates.*directive|refused to (execute|load)/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  try {
    await page.goto(base);
    await expect(
      page.getByRole('heading', { name: 'Hi, I’m Sergio Navarro.' }),
    ).toBeVisible();

    await page
      .getByRole('link', { name: 'Fixture outbound', exact: true })
      .click();
    await expect.poll(() => events.includes('outbound-click')).toBe(true);
    await page.goto(base + '/projects');
    await page
      .getByRole('link', { name: 'Visit project ↗', exact: true })
      .click();
    await expect.poll(() => events.includes('project-click')).toBe(true);
    await page.goto(base + '/posts?q=unfindablebrowserfixture');
    await expect(page.locator('[data-no-results]')).toBeVisible();
    await expect.poll(() => events.includes('search-no-results')).toBe(true);
    await page.goto(base + '/posts/structured-title');
    assert.equal(
      await page.evaluate(() => (window as any).compromised),
      undefined,
    );
    const ld = await page
      .locator('script[type="application/ld+json"]')
      .textContent();
    assert.equal(
      JSON.parse(ld!).headline,
      '</script><script>window.compromised=true</script><p> & café',
    );

    await context.addCookies([
      {
        name: 'blog_dev_session',
        value: cookie.slice(cookie.indexOf('=') + 1),
        url: base,
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);
    await page.goto(base + '/admin/edit?id=' + postId);
    const body = page.locator('#body');
    await page.getByRole('button', { name: 'Markdown', exact: true }).click();
    await body.fill('editor smoke');
    await body.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(body).toHaveValue('**editor smoke**');
    await body.press('ControlOrMeta+z');
    await expect(body).toHaveValue('editor smoke');
    await body.press('ControlOrMeta+Shift+z');
    await expect(body).toHaveValue('**editor smoke**');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('#preview strong')).toHaveText('editor smoke');
    await page.getByRole('button', { name: 'Close preview' }).click();
    await page
      .locator('.media-upload select[name=target]')
      .selectOption('body');
    await page.locator('.media-upload input[type=file]').setInputFiles({
      name: 'browser.png',
      mimeType: 'image/png',
      buffer: image,
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.locator('.upload-result')).toHaveText(
      /^Selected: \/uploads\/[a-f0-9-]+\.webp$/,
    );
    const uploadedPath = (await page
      .locator('.upload-result')
      .textContent())!.replace('Selected: ', '');
    await expect(body).toHaveValue(
      new RegExp(uploadedPath.replaceAll('.', '\\.')),
    );
    const served = await context.request.get(base + uploadedPath);
    assert.equal(served.status(), 200);
    assert.equal(served.headers()['content-type'], 'image/webp');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.locator('#save-status')).toHaveText(/^Saved at/);
    const { adminBrowserChecks } = await import('./admin-browser');
    await adminBrowserChecks(context, base);
    // Smoke every private form page too; the preview and all editor JS must be excluded from tracking.
    const before = events.length;
    for (const route of [
      '/admin',
      '/admin/projects',
      '/admin/settings',
      '/admin/inbox',
      '/admin/tags',
    ])
      await page.goto(base + route);
    assert.equal(events.length, before);
    assert.deepEqual(violations, [], 'CSP violations');
    assert.deepEqual(errors, [], 'Browser script/console errors');
    console.log(
      'Chromium smoke passed: external events, formatting, preview, upload, safe JSON-LD, no CSP violations.',
    );
  } finally {
    await browser.close();
  }
}
