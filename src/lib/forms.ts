export class FormBodyError extends Error {
  constructor(public status: 400 | 415) {
    super('Invalid input');
  }
}

export async function readFormBody(request: Request) {
  if (!request.body) throw new FormBodyError(400);
  const type = request.headers
    .get('content-type')
    ?.split(';')[0]
    .trim()
    .toLowerCase();
  if (!type) throw new FormBodyError(400);
  if (
    type !== 'application/x-www-form-urlencoded' &&
    type !== 'multipart/form-data'
  )
    throw new FormBodyError(415);
  try {
    return await request.formData();
  } catch {
    throw new FormBodyError(400);
  }
}

export function loginFields(form: FormData) {
  const passwords = form.getAll('password');
  const codes = form.getAll('code');
  const password = passwords[0];
  const code = codes[0];
  if (
    passwords.length !== 1 ||
    codes.length !== 1 ||
    typeof password !== 'string' ||
    typeof code !== 'string' ||
    !password.length ||
    password.length > 1024 ||
    !/^\d{6}$/.test(code)
  )
    throw new FormBodyError(400);
  return { password, code };
}
