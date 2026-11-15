function bytesToBase64url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}
function base64urlToBytes(value: string) {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function serializeCredential(credential: PublicKeyCredential) {
  const response = credential.response;
  const shared = {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if (response instanceof AuthenticatorAttestationResponse) {
    const transports =
      'getTransports' in response &&
      typeof response.getTransports === 'function'
        ? response.getTransports()
        : undefined;
    return {
      ...shared,
      response: {
        clientDataJSON: bytesToBase64url(response.clientDataJSON),
        attestationObject: bytesToBase64url(response.attestationObject),
        transports,
      },
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...shared,
    response: {
      clientDataJSON: bytesToBase64url(assertion.clientDataJSON),
      authenticatorData: bytesToBase64url(assertion.authenticatorData),
      signature: bytesToBase64url(assertion.signature),
      userHandle: assertion.userHandle
        ? bytesToBase64url(assertion.userHandle)
        : undefined,
    },
  };
}
function prepareCreation(options: any): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64urlToBytes(options.challenge),
    user: { ...options.user, id: base64urlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item: any) => ({
      ...item,
      id: base64urlToBytes(item.id),
    })),
  };
}
function prepareRequest(options: any): PublicKeyCredentialRequestOptions {
  const { allowCredentials, ...rest } = options;
  return {
    ...rest,
    challenge: base64urlToBytes(options.challenge),
    ...(allowCredentials?.length
      ? {
          allowCredentials: allowCredentials.map((item: any) => ({
            ...item,
            id: base64urlToBytes(item.id),
          })),
        }
      : {}),
  };
}
async function send(url: string, method: string, csrf: string, body?: unknown) {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (csrf) headers['x-csrf'] = csrf;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to update passkeys.');
  return data;
}
function show(target: HTMLElement | null, message: string) {
  if (!target) return;
  target.hidden = !message;
  target.textContent = message;
}
const loginButton = document.querySelector<HTMLButtonElement>('#passkey-login');
if (loginButton) {
  const output = document.querySelector<HTMLElement>('#passkey-login-error');
  loginButton.addEventListener('click', async () => {
    show(output, '');
    if (!navigator.credentials?.get) {
      show(
        output,
        'This browser cannot use a passkey. Use the password and authenticator code.',
      );
      return;
    }
    loginButton.disabled = true;
    try {
      const options = await send(
        '/api/admin/login/passkey/options',
        'POST',
        '',
      );
      const credential = await navigator.credentials.get({
        publicKey: prepareRequest(options),
      });
      if (!(credential instanceof PublicKeyCredential))
        throw new Error('Unable to sign in');
      const result = await send(
        '/api/admin/login/passkey',
        'POST',
        '',
        serializeCredential(credential),
      );
      location.assign(result.redirect || '/admin');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        show(output, 'Passkey sign-in was cancelled.');
      else show(output, 'Unable to sign in');
    } finally {
      loginButton.disabled = false;
    }
  });
}
const panel = document.querySelector<HTMLElement>('[data-passkeys]');
if (panel) {
  const csrf = panel.dataset.csrf || '';
  const output = panel.querySelector<HTMLElement>('[data-passkey-message]');
  const add = panel.querySelector<HTMLButtonElement>('[data-passkey-add]');
  add?.addEventListener('click', async () => {
    show(output, '');
    if (!navigator.credentials?.create) {
      show(output, 'This browser cannot create a passkey.');
      return;
    }
    add.disabled = true;
    try {
      const options = await send('/api/admin/passkeys/options', 'POST', csrf);
      const credential = await navigator.credentials.create({
        publicKey: prepareCreation(options),
      });
      if (!(credential instanceof PublicKeyCredential))
        throw new Error('Unable to update passkeys.');
      const name =
        panel.querySelector<HTMLInputElement>('[data-passkey-name]')?.value ||
        '';
      await send('/api/admin/passkeys', 'POST', csrf, {
        name,
        credential: serializeCredential(credential),
      });
      location.reload();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        show(output, 'Passkey creation was cancelled.');
      else
        show(
          output,
          error instanceof Error ? error.message : 'Unable to update passkeys.',
        );
      add.disabled = false;
    }
  });
  panel
    .querySelectorAll<HTMLButtonElement>('[data-passkey-rename]')
    .forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest<HTMLElement>('[data-passkey-id]');
        const name = row?.querySelector<HTMLInputElement>('input')?.value;
        show(output, '');
        button.disabled = true;
        try {
          await send(
            '/api/admin/passkeys/' + row?.dataset.passkeyId,
            'PATCH',
            csrf,
            { name },
          );
          location.reload();
        } catch (error) {
          show(
            output,
            error instanceof Error
              ? error.message
              : 'Unable to update passkeys.',
          );
          button.disabled = false;
        }
      });
    });
  panel
    .querySelectorAll<HTMLButtonElement>('[data-passkey-delete]')
    .forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest<HTMLElement>('[data-passkey-id]');
        if (!window.confirm('Delete this passkey?')) return;
        show(output, '');
        button.disabled = true;
        try {
          await send(
            '/api/admin/passkeys/' + row?.dataset.passkeyId,
            'DELETE',
            csrf,
          );
          location.reload();
        } catch (error) {
          show(
            output,
            error instanceof Error
              ? error.message
              : 'Unable to update passkeys.',
          );
          button.disabled = false;
        }
      });
    });
}
