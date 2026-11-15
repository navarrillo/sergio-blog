import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

function head(major: number, length: number) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const bytes = Buffer.alloc(3);
  bytes[0] = (major << 5) | 25;
  bytes.writeUInt16BE(length, 1);
  return bytes;
}
function cborBytes(value: Buffer) {
  return Buffer.concat([head(2, value.length), value]);
}
function cborText(value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([head(3, bytes.length), bytes]);
}
function cborUint(value: number) {
  return head(0, value);
}
function cborNeg(value: number) {
  return head(1, -1 - value);
}
function cborMap(pairs: Buffer[]) {
  return Buffer.concat([head(5, pairs.length / 2), ...pairs]);
}
function coseKey(x: Buffer, y: Buffer) {
  return cborMap([
    cborUint(1),
    cborUint(2),
    cborUint(3),
    cborNeg(-7),
    cborNeg(-1),
    cborUint(1),
    cborNeg(-2),
    cborBytes(x),
    cborNeg(-3),
    cborBytes(y),
  ]);
}
function attestation(authData: Buffer) {
  return cborMap([
    cborText('fmt'),
    cborText('none'),
    cborText('attStmt'),
    cborMap([]),
    cborText('authData'),
    cborBytes(authData),
  ]);
}

export class SoftPasskey {
  private key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  readonly credentialId = randomBytes(32);
  signCount = 0;
  userHandle = '';
  constructor(private freezeCounter = false) {}
  private cose() {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as {
      x: string;
      y: string;
    };
    return coseKey(
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    );
  }
  private authenticatorData(
    rpId: string,
    count: number,
    uv: boolean,
    attested: boolean,
  ) {
    const flags = 0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(count);
    const parts = [
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      counter,
    ];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, this.cose());
    }
    return Buffer.concat(parts);
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }
  private body(
    clientData: Buffer,
    response: Record<string, string | string[]>,
  ) {
    const id = this.credentialId.toString('base64url');
    return {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        ...response,
      },
    };
  }
  register(options: any, origin: string, rpId = options.rp.id) {
    this.userHandle = options.user.id;
    const authData = this.authenticatorData(rpId, 0, true, true);
    return this.body(
      this.clientData('webauthn.create', options.challenge, origin),
      {
        attestationObject: attestation(authData).toString('base64url'),
        transports: ['internal'],
      },
    );
  }
  authenticate(
    options: any,
    origin: string,
    extra: { rpId?: string; uv?: boolean } = {},
  ) {
    if (!this.freezeCounter) this.signCount += 1;
    const rpId = extra.rpId || options.rpId;
    const authData = this.authenticatorData(
      rpId,
      this.signCount,
      extra.uv !== false,
      false,
    );
    const clientData = this.clientData(
      'webauthn.get',
      options.challenge,
      origin,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([
        authData,
        createHash('sha256').update(clientData).digest(),
      ]),
      this.key.privateKey,
    );
    return this.body(clientData, {
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
      userHandle: this.userHandle,
    });
  }
}
