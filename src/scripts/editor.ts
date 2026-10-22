const body = document.querySelector<HTMLTextAreaElement>('#body');
const slug = document.querySelector<HTMLInputElement>('#slug');
const title = document.querySelector<HTMLInputElement>('#post-title');
let slugEdited = Boolean(slug?.value);
slug?.addEventListener('input', () => {
  slugEdited = true;
});
title?.addEventListener('input', () => {
  if (slug && !slugEdited)
    slug.value = title.value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
});
document
  .querySelectorAll<HTMLButtonElement>('[data-wrap],[data-prefix]')
  .forEach((button) =>
    button.addEventListener('click', () => {
      if (!body) return;
      const start = body.selectionStart,
        end = body.selectionEnd;
      const selected = body.value.slice(start, end) || 'text';
      const wrap = button.dataset.wrap || '';
      body.setRangeText(
        (button.dataset.prefix || '') + wrap + selected + wrap,
        start,
        end,
        'select',
      );
      body.focus();
    }),
  );
document.querySelector('#insert-link')?.addEventListener('click', () => {
  if (!body) return;
  body.setRangeText(
    `[${body.value.slice(body.selectionStart, body.selectionEnd) || 'link text'}](https://example.com)`,
    body.selectionStart,
    body.selectionEnd,
    'select',
  );
  body.focus();
});
document
  .querySelector('#preview-button')
  ?.addEventListener('click', async () => {
    const form = document.querySelector<HTMLFormElement>('#post-form')!;
    const preview = document.querySelector<HTMLElement>('#preview')!;
    const response = await fetch('/api/admin/preview', {
      method: 'POST',
      body: new FormData(form),
    });
    if (response.ok) {
      preview.innerHTML = await response.text();
      preview.hidden = false;
      preview.scrollIntoView({ behavior: 'smooth' });
    }
  });
document
  .querySelector<HTMLFormElement>('#upload-form')
  ?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const output = document.querySelector<HTMLOutputElement>('#upload-result')!;
    const response = await fetch('/api/admin/upload', {
      method: 'POST',
      body: new FormData(event.currentTarget as HTMLFormElement),
    });
    if (response.ok) {
      const { path } = await response.json();
      output.textContent = path;
      if (body)
        body.setRangeText(
          `\n![Image description](${path})\n`,
          body.selectionStart,
          body.selectionEnd,
          'end',
        );
    } else output.textContent = await response.text();
  });
export {};
