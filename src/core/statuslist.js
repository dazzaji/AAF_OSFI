// Status list: one bit per issued credential or claim (0 = valid, 1 = revoked),
// deflate-compressed and published as one signed snapshot. Verifiers fetch the
// whole list on a timer, so the directory never learns which entry they checked.
// Follows the shape of the IETF Token Status List draft (bits = 1).
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { b64u, unb64u } from './util.js';

export const LIST_BITS = 1 << 16; // 65,536 entries; ample for a pilot

export const emptyList = () => Buffer.alloc(LIST_BITS / 8);
export const getBit = (buf, idx) => (buf[idx >> 3] >> (idx & 7)) & 1;
export const setBit = (buf, idx) => { buf[idx >> 3] |= 1 << (idx & 7); };
export const encodeList = (buf) => b64u(zlib.deflateSync(buf, { level: 9 }));
export const decodeList = (lst) => zlib.inflateSync(unb64u(lst));

// Random, not sequential, so neighbouring indexes say nothing about issuance order.
export function randomFreeIndex(isUsed) {
  for (let i = 0; i < 200; i++) {
    const idx = crypto.randomInt(LIST_BITS);
    if (!isUsed(idx)) return idx;
  }
  throw new Error('status list is full');
}
