// Protobuf wire format, only as much as Chrome's saved tab groups need.
//
// A value stored under `saved_tab_group-dt-<uuid>` is a DataTypeStore wrapper:
//   { 1: schema version, 2: SavedTabGroupSpecifics }
// SavedTabGroupSpecifics { 1: guid, 2: created us, 3: updated us, 4: group, 5: tab }
//   group { 2: title, 3: color, 4: position }
//   tab   { 1: group guid, 2: position, 3: url, 4: title }
const WIRE_VARINT = 0;
const WIRE_LEN = 2;
function readVarint(buf, start) {
    let value = 0n;
    let shift = 0n;
    let i = start;
    while (i < buf.length) {
        const byte = buf[i++];
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            return [value, i];
        shift += 7n;
    }
    throw new Error(`truncated varint at byte ${start}`);
}
export function decode(buf) {
    const fields = new Map();
    let i = 0;
    while (i < buf.length) {
        const [tag, afterTag] = readVarint(buf, i);
        i = afterTag;
        const field = Number(tag >> 3n);
        const wire = Number(tag & 7n);
        if (wire === WIRE_VARINT) {
            const [value, next] = readVarint(buf, i);
            fields.set(field, value);
            i = next;
        }
        else if (wire === WIRE_LEN) {
            const [len, next] = readVarint(buf, i);
            const end = next + Number(len);
            if (end > buf.length)
                throw new Error(`length-delimited field ${field} runs past the buffer`);
            fields.set(field, buf.subarray(next, end));
            i = end;
        }
        else {
            throw new Error(`unsupported wire type ${wire} for field ${field}`);
        }
    }
    return fields;
}
function writeVarint(value, out) {
    let v = value;
    do {
        const byte = Number(v & 0x7fn);
        v >>= 7n;
        out.push(v > 0n ? byte | 0x80 : byte);
    } while (v > 0n);
}
/** Encodes fields in ascending field number, which is what Chrome writes too. */
export function encode(fields) {
    const out = [];
    for (const field of [...fields.keys()].sort((a, b) => a - b)) {
        const value = fields.get(field);
        if (typeof value === 'bigint') {
            writeVarint(BigInt(field << 3) | BigInt(WIRE_VARINT), out);
            writeVarint(value, out);
        }
        else {
            writeVarint(BigInt(field << 3) | BigInt(WIRE_LEN), out);
            writeVarint(BigInt(value.length), out);
            for (const byte of value)
                out.push(byte);
        }
    }
    return Uint8Array.from(out);
}
export const text = (value) => new TextEncoder().encode(value);
const str = (value) => value instanceof Uint8Array ? new TextDecoder().decode(value) : null;
const int = (value) => typeof value === 'bigint' ? Number(value) : null;
const bytes = (value) => value instanceof Uint8Array ? value : null;
/** Reads one LevelDB value into the entity it describes. */
export function parseRecord(value) {
    const specifics = bytes(decode(value).get(2));
    if (!specifics)
        return { kind: 'unknown', guid: null };
    const spec = decode(specifics);
    const guid = str(spec.get(1));
    const groupBytes = bytes(spec.get(4));
    if (groupBytes) {
        const group = decode(groupBytes);
        return { kind: 'group', guid, title: str(group.get(2)) ?? '', color: int(group.get(3)), position: int(group.get(4)) };
    }
    const tabBytes = bytes(spec.get(5));
    if (tabBytes) {
        const tab = decode(tabBytes);
        return {
            kind: 'tab',
            guid,
            groupGuid: str(tab.get(1)),
            position: int(tab.get(2)),
            url: str(tab.get(3)) ?? '',
            title: str(tab.get(4)) ?? ''
        };
    }
    return { kind: 'unknown', guid };
}
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const colorName = (color) => color === null ? 'unset' : (COLORS[color - 1] ?? String(color));
/** Windows epoch (1601) microseconds, as Chrome stores timestamps. */
export const windowsEpochToDate = (micros) => new Date(micros / 1000 - 11644473600000);
