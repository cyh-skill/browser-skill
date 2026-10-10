import { decode, encode } from './proto.js';
// sync_pb::EntityMetadata, the record beside each entity at `<type>-md-<storage key>`.
// Field numbers read out of a live Chrome store, not assumed:
//   1 client_tag_hash   2 server_id   3 is_deleted   4 sequence_number
//   5 acked_sequence_number   6 server_version
//   7 creation_time ms   8 modification_time ms   9 specifics_hash
export const CLIENT_TAG_HASH = 1;
export const IS_DELETED = 3;
export const SEQUENCE_NUMBER = 4;
export const ACKED_SEQUENCE_NUMBER = 5;
export const MODIFICATION_TIME = 8;
export const SPECIFICS_HASH = 9;
const same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
/**
 * Refuses any record this reader cannot reproduce byte for byte. Repeated fields
 * and unusual field orders would survive decoding but not re-encoding, and a
 * metadata record Chrome considers inconsistent makes it clear the whole data
 * type and download it again.
 */
export function assertReadable(raw, key) {
    if (!same(encode(decode(raw)), raw)) {
        throw new Error(`metadata at ${key} does not round-trip through this reader - refusing to rewrite it`);
    }
}
/**
 * Marks an entity deleted on purpose: the data record goes, this record stays
 * with is_deleted set and a sequence number ahead of the acked one, which is
 * what the sync processor reads on startup as an uncommitted local change. It
 * then commits the deletion, and every other device drops the group too.
 */
export function tombstone(raw, key, nowMs) {
    assertReadable(raw, key);
    const metadata = decode(raw);
    const clientTagHash = metadata.get(CLIENT_TAG_HASH);
    if (!(clientTagHash instanceof Uint8Array) || clientTagHash.length === 0) {
        throw new Error(`metadata at ${key} has no client tag hash - it is not an entity Chrome is tracking`);
    }
    const acked = metadata.get(ACKED_SEQUENCE_NUMBER) ?? 0n;
    const sequence = metadata.get(SEQUENCE_NUMBER) ?? 0n;
    if (typeof acked !== 'bigint' || typeof sequence !== 'bigint') {
        throw new Error(`metadata at ${key} has sequence numbers of an unexpected shape`);
    }
    metadata.set(IS_DELETED, 1n);
    metadata.set(SEQUENCE_NUMBER, (sequence > acked ? sequence : acked) + 1n);
    metadata.set(MODIFICATION_TIME, BigInt(nowMs));
    metadata.delete(SPECIFICS_HASH);
    return encode(metadata);
}
export const isTombstone = (raw) => decode(raw).get(IS_DELETED) === 1n;
