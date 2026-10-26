export class AdminRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export function formData(form: HTMLFormElement) {
  const data = new FormData(form);
  const values: Record<string, string> = {};
  for (const field of form.querySelectorAll<HTMLTextAreaElement>(
    'textarea[name]',
  )) {
    if (
      field.disabled ||
      !['body', 'summary', 'bio', 'description', 'text'].includes(field.name)
    )
      continue;
    let value = field.value;
    if (field.dataset.originalValue) {
      const original = JSON.parse(field.dataset.originalValue) as string;
      if (value === original.replace(/\r\n?/g, '\n')) value = original;
    }
    values[field.name] = value;
  }
  // Multipart form serialization otherwise normalizes textarea LF to CRLF.
  data.set('text_values', JSON.stringify(values));
  return data;
}
export async function adminRequest(
  action: string,
  data: FormData,
  refreshSession = true,
): Promise<any> {
  const response = await fetch(action, {
    method: 'POST',
    body: data,
    headers: { Accept: 'application/json' },
  });
  if (refreshSession && (response.status === 401 || response.status === 403)) {
    const session = await fetch('/api/admin/session');
    if (session.ok) {
      const { csrf } = await session.json();
      document
        .querySelectorAll<HTMLInputElement>('input[name="csrf"]')
        .forEach((input) => {
          input.value = csrf;
        });
      data.set('csrf', csrf);
      return adminRequest(action, data, false);
    }
  }
  if (response.redirected && response.ok) return { redirect: response.url };
  const json = response.headers
    .get('content-type')
    ?.includes('application/json');
  const result = json
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok)
    throw new AdminRequestError(
      response.status === 401
        ? 'Your session expired. Your changes are still here. Sign in again in another tab, then retry.'
        : result.error || 'Request failed. Please retry.',
      response.status,
      result.fields,
    );
  return result;
}
export function showFormError(form: HTMLFormElement, error: unknown) {
  form.querySelectorAll('[data-field-error]').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid]').forEach((el) => {
    el.removeAttribute('aria-invalid');
    if (el.getAttribute('aria-describedby')?.startsWith('error-'))
      el.removeAttribute('aria-describedby');
  });
  let output = form.querySelector<HTMLElement>(
    '[data-form-result],#editor-error',
  );
  if (!output) {
    output = document.createElement('p');
    output.dataset.formResult = '';
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');
    form.append(output);
  }
  output.textContent =
    error instanceof Error ? error.message : 'Request failed. Please retry.';
  output.className = 'form-error';
  if (
    error instanceof AdminRequestError &&
    (error.status === 401 || error.status === 403)
  ) {
    const link = document.createElement('a');
    link.href = '/admin/login';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = ' Sign in in another tab';
    output.append(link);
  }
  if (error instanceof AdminRequestError)
    for (const [name, message] of Object.entries(error.fields)) {
      const indexed = name.match(/^(.+)\[(\d+)\]$/);
      const control = indexed
        ? Array.from(form.elements).filter(
            (el) => (el as HTMLInputElement).name === indexed[1],
          )[Number(indexed[2])]
        : form.elements.namedItem(name);
      if (!(control instanceof HTMLElement)) continue;
      control.setAttribute('aria-invalid', 'true');
      const help = document.createElement('span');
      help.className = 'field-error';
      help.dataset.fieldError = '';
      help.textContent = message;
      const errorId = 'error-' + (form.id || 'form') + '-' + name;
      help.id = errorId;
      control.setAttribute('aria-describedby', errorId);
      control.after(help);
    }
}
document
  .querySelectorAll<HTMLFormElement>('form[data-admin-form]')
  .forEach((form) => {
    let pending = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pending || !form.reportValidity()) return;
      const intent = new FormData(form).get('intent');
      const confirmation =
        form.dataset.confirm ||
        (form.id === 'bulk-form' && intent === 'trash'
          ? 'Move the selected posts to trash? They will be hidden and remain recoverable.'
          : '');
      if (confirmation && !window.confirm(confirmation)) return;
      pending = true;
      const data = formData(form);
      form.dispatchEvent(new Event('admin:saving'));
      form
        .querySelectorAll<HTMLInputElement>('[data-utc-input]')
        .forEach((input) => {
          if (input.value)
            data.set(input.name, new Date(input.value).toISOString());
        });
      const buttons = Array.from(
        form.querySelectorAll<HTMLButtonElement>(
          'button[type=submit],button:not([type])',
        ),
      );
      buttons.forEach((button) => {
        button.disabled = true;
      });
      try {
        const result = await adminRequest(form.action, data);
        form.dispatchEvent(new Event('admin:saved'));
        if (form.hasAttribute('data-reload')) location.reload();
        else if (
          form.hasAttribute('data-login') ||
          form.hasAttribute('data-import') ||
          form.hasAttribute('data-convert') ||
          form.dataset.redirect
        )
          location.assign(form.dataset.redirect || result.redirect);
        else {
          showFormError(
            form,
            new Error(result.message || 'Saved successfully.'),
          );
          form.querySelector<HTMLElement>('[data-form-result]')!.className =
            'notice';
        }
      } catch (error) {
        showFormError(form, error);
        form.dispatchEvent(new Event('admin:save-error'));
      } finally {
        pending = false;
        buttons.forEach((button) => {
          button.disabled = false;
        });
      }
    });
  });
document.querySelectorAll<HTMLElement>('[data-local-time]').forEach((time) => {
  const date = new Date(time.getAttribute('datetime') || '');
  if (Number.isFinite(+date)) {
    time.textContent = date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    time.title = date.toISOString();
  }
});
document.querySelectorAll('[data-timezone]').forEach((el) => {
  el.textContent = '(' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')';
});
for (const id of ['bulk-form', 'inbox-selection']) {
  const form = document.getElementById(id) as HTMLFormElement | null;
  if (!form) continue;
  const checks = Array.from(form.elements).filter(
    (el): el is HTMLInputElement =>
      el instanceof HTMLInputElement && el.name === 'selected' && !el.disabled,
  );
  const all = document.querySelector<HTMLInputElement>(
    `[data-select-all="${id}"]`,
  );
  const update = () => {
    const count = checks.filter((el) => el.checked).length;
    form.querySelector('[data-selection-count]')!.textContent =
      count + ' selected';
    form
      .querySelectorAll<HTMLButtonElement>('[data-requires-selection]')
      .forEach((button) => {
        button.disabled = !count;
      });
    if (all) {
      all.checked = checks.length > 0 && count === checks.length;
      all.indeterminate = count > 0 && count < checks.length;
    }
  };
  checks.forEach((check) => check.addEventListener('change', update));
  all?.addEventListener('change', () => {
    checks.forEach((check) => {
      check.checked = all.checked;
    });
    update();
  });
  update();
}
document.querySelectorAll<HTMLElement>('.media-picker').forEach((picker) => {
  const form = picker.querySelector<HTMLFormElement>('form')!;
  const output = picker.querySelector<HTMLOutputElement>('.upload-result')!;
  const progress = picker.querySelector<HTMLProgressElement>('progress')!;
  const target = () =>
    (form.elements.namedItem('target') as HTMLSelectElement).value;
  const choose = (path: string) => {
    const destination = target();
    const alt =
      (form.elements.namedItem('alt') as HTMLInputElement | null)?.value || '';
    document.dispatchEvent(
      new CustomEvent('admin:image', {
        detail: { path, target: destination, alt },
      }),
    );
    if (destination !== 'body') {
      const input = document.querySelector<HTMLInputElement>(
        `input[name="${destination}"]`,
      );
      if (input) {
        input.value = path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const preview = document.querySelector<HTMLImageElement>(
        `[data-image-preview="${destination}"],#cover-preview`,
      );
      if (preview) {
        preview.hidden = !path;
        if (path) preview.src = path;
        else preview.removeAttribute('src');
      }
    }
    output.textContent = path
      ? 'Selected: ' + path
      : 'Cover / photo removed. Save to keep this change.';
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const file = (form.elements.namedItem('file') as HTMLInputElement)
      .files?.[0];
    if (!file || file.size > 8 * 1024 * 1024) {
      output.textContent = 'Choose an image up to 8 MB.';
      return;
    }
    const button = form.querySelector<HTMLButtonElement>('button')!;
    const data = new FormData(form);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('Accept', 'application/json');
    progress.hidden = false;
    progress.value = 0;
    button.disabled = true;
    form.inert = true;
    output.textContent = 'Uploading…';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress.value = (event.loaded / event.total) * 100;
    };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          choose(result.path);
          form.reset();
        } else
          output.textContent = result.error || 'Upload failed. Please retry.';
      } catch {
        output.textContent =
          xhr.status === 401
            ? 'Session expired. Sign in again, then retry.'
            : 'Upload failed. Please retry.';
      }
    };
    xhr.onerror = () => {
      output.textContent = 'Connection lost. Please retry the upload.';
    };
    xhr.onloadend = () => {
      button.disabled = false;
      progress.hidden = true;
      form.inert = false;
    };
    xhr.send(data);
  });
  let images: { path: string }[] | undefined;
  picker.querySelector('.browse-media')?.addEventListener('click', async () => {
    const library = picker.querySelector<HTMLElement>('.media-library')!;
    if (!library.hidden) {
      library.hidden = true;
      return;
    }
    library.hidden = false;
    try {
      if (!images) {
        const response = await fetch('/api/admin/media');
        if (!response.ok)
          throw new Error('Unable to load images. Sign in again or retry.');
        images = await response.json();
      }
      library.replaceChildren();
      let shown = 0;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'quiet';
      more.textContent = 'Show more images';
      const render = () => {
        for (const image of images!.slice(shown, shown + 24)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'media-thumbnail';
          const img = document.createElement('img');
          img.src = image.path;
          img.alt = 'Choose uploaded image';
          img.loading = 'lazy';
          button.title = image.path;
          button.append(img);
          button.addEventListener('click', () => choose(image.path));
          library.insertBefore(button, more.parentNode ? more : null);
        }
        shown += 24;
        if (shown < images!.length) library.append(more);
        else more.remove();
      };
      more.addEventListener('click', render);
      render();
      if (!images!.length) library.textContent = 'No uploaded images yet.';
    } catch (error) {
      output.textContent = (error as Error).message;
    }
  });
  picker.querySelector('.remove-cover')?.addEventListener('click', () => {
    const select = form.elements.namedItem('target') as HTMLSelectElement;
    select.value = picker.dataset.target!;
    choose('');
  });
});
const profileLinks = document.querySelector('#profile-links');
profileLinks?.addEventListener('click', (event) => {
  const button = (event.target as Element).closest('.remove-link');
  button?.closest('.profile-link-row')?.remove();
});
document.querySelector('#add-link')?.addEventListener('click', () => {
  const row = document.createElement('div');
  row.className = 'profile-link-row';
  for (const [name, label] of [
    ['link_label', 'Label'],
    ['link_url', 'URL'],
  ]) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const input = document.createElement('input');
    input.name = name;
    input.type = name === 'link_url' ? 'url' : 'text';
    if (name === 'link_label') input.maxLength = 100;
    wrapper.append(input);
    row.append(wrapper);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet remove-link';
  button.textContent = 'Remove';
  row.append(button);
  profileLinks?.append(row);
  row.querySelector('input')?.focus();
});
document
  .querySelector<HTMLSelectElement>('#old-tag')
  ?.addEventListener('change', (event) => {
    const option = (event.target as HTMLSelectElement).selectedOptions[0];
    document.querySelector('#tag-impact')!.textContent = option.dataset.count
      ? `This change affects ${option.dataset.count} posts, including their live and private copies.`
      : 'Choose a tag to see how many posts will change.';
  });
