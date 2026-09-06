"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const winapi = require("winapi-bindings");
const fs = require("fs");
//
// [linux-vortex] winapi-bindings implements the Win32 profile (.ini) functions only on
// Windows; everywhere else its index.js exports an empty object. vortex-parse-ini ships
// exactly one backend - this one - so on Linux EVERY ini read/write throws
// "winapi.GetPrivateProfileSectionNames is not a function". That breaks witcher3's
// mods.settings (wiping the load order file on every deploy), the gamebryo ini tweaks,
// morrowind, bepinex, mo-import, sims4, msfs, vtmbloodlines and Vortex core's own
// game-settings handling.
//
// When the native functions are missing, fall back to an equivalent pure-JS
// implementation that keeps the Win32 profile semantics the callers expect:
//   - section/key lookup is case-insensitive and the first occurrence wins
//   - keys that appear before any section header are not addressable
//   - a write is a per-key edit: comments, blank lines, key order and unrelated
//     sections are left exactly as they were
//   - the file's existing encoding (UTF-16LE / UTF-8 / 8-bit) and line endings survive
//
const NATIVE_INI_FUNCS = [
    'GetPrivateProfileSectionNames',
    'GetPrivateProfileSection',
    'WritePrivateProfileString',
];
const hasNativeIni = NATIVE_INI_FUNCS.every((name) => typeof winapi[name] === 'function');
const SECTION_PATTERN = /^\[([^\]]*)\]$/;
const BOMS = { utf16le: Buffer.from([0xFF, 0xFE]), utf8: Buffer.from([0xEF, 0xBB, 0xBF]) };
function decodeFile(filePath) {
    let buffer;
    try {
        buffer = fs.readFileSync(filePath);
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
        // Win32 treats a missing profile as an empty one
        buffer = Buffer.alloc(0);
    }
    if ((buffer.length >= 2) && (buffer[0] === 0xFF) && (buffer[1] === 0xFE)) {
        return { text: buffer.toString('utf16le', 2), encoding: 'utf16le', bom: true };
    }
    if ((buffer.length >= 3) && (buffer[0] === 0xEF) && (buffer[1] === 0xBB) && (buffer[2] === 0xBF)) {
        return { text: buffer.toString('utf8', 3), encoding: 'utf8', bom: true };
    }
    const text = buffer.toString('utf8');
    // if the bytes aren't valid utf8 (an ANSI ini, say) decode as latin1, which round-trips
    // every byte unchanged instead of replacing it with U+FFFD.
    return (Buffer.compare(Buffer.from(text, 'utf8'), buffer) === 0)
        ? { text, encoding: 'utf8', bom: false }
        : { text: buffer.toString('latin1'), encoding: 'latin1', bom: false };
}
function encodeFile(filePath, text, encoding, bom) {
    const body = Buffer.from(text, encoding);
    fs.writeFileSync(filePath, bom ? Buffer.concat([BOMS[encoding], body]) : body);
}
function isIgnored(line) {
    return (line === '') || line.startsWith(';') || line.startsWith('#');
}
function sectionName(line) {
    const match = SECTION_PATTERN.exec(line.trim());
    return (match !== null) ? match[1].trim() : undefined;
}
function splitKey(line) {
    const trimmed = line.trim();
    if (isIgnored(trimmed)) {
        return undefined;
    }
    const idx = trimmed.indexOf('=');
    return (idx === -1)
        ? undefined
        : { key: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() };
}
function parseIni(text) {
    const result = {};
    let section;
    text.split(/\r?\n/).forEach((line) => {
        const name = sectionName(line);
        if (name !== undefined) {
            section = name;
            if (result[section] === undefined) {
                result[section] = {};
            }
            return;
        }
        if (section === undefined) {
            return;
        }
        const entry = splitKey(line);
        // first occurrence wins, like GetPrivateProfileString
        if ((entry !== undefined) && (result[section][entry.key] === undefined)) {
            result[section][entry.key] = entry.value;
        }
    });
    return result;
}
function applyChange(lines, section, key, value) {
    const same = (lhs, rhs) => lhs.toLowerCase() === rhs.toLowerCase();
    let sectionStart = lines.findIndex((line) => {
        const name = sectionName(line);
        return (name !== undefined) && same(name, section);
    });
    if (sectionStart === -1) {
        if (value === null) {
            return;
        }
        if ((lines.length > 0) && (lines[lines.length - 1].trim() !== '')) {
            lines.push('');
        }
        lines.push('[' + section + ']', key + '=' + value);
        return;
    }
    let sectionEnd = lines.length;
    for (let idx = sectionStart + 1; idx < lines.length; ++idx) {
        if (sectionName(lines[idx]) !== undefined) {
            sectionEnd = idx;
            break;
        }
    }
    for (let idx = sectionStart + 1; idx < sectionEnd; ++idx) {
        const entry = splitKey(lines[idx]);
        if ((entry === undefined) || !same(entry.key, key)) {
            continue;
        }
        if (value === null) {
            lines.splice(idx, 1);
        }
        else {
            lines[idx] = key + '=' + value;
        }
        return;
    }
    if (value === null) {
        return;
    }
    // new key: append it to the section, before any trailing blank lines
    let insertAt = sectionEnd;
    while ((insertAt > sectionStart + 1) && (lines[insertAt - 1].trim() === '')) {
        --insertAt;
    }
    lines.splice(insertAt, 0, key + '=' + value);
}
function writeIni(filePath, changes) {
    const file = decodeFile(filePath);
    const eol = /\r\n/.test(file.text) ? '\r\n' : '\n';
    const lines = (file.text === '') ? [] : file.text.split(/\r?\n/);
    changes.forEach((change) => applyChange(lines, change.section, change.key, change.value));
    encodeFile(filePath, lines.join(eol), file.encoding, file.bom);
}
class WinapiFormat {
    constructor() {
    }
    read(filePath) {
        if (!hasNativeIni) {
            try {
                return Promise.resolve(parseIni(decodeFile(filePath).text));
            }
            catch (err) {
                return Promise.reject(err);
            }
        }
        const output = {};
        return this.readSectionList(filePath)
            .then((sections) => Promise.all(sections.map((section) => this.readSection(filePath, section)
            .then((content) => {
            output[section] = content;
        }))))
            .then(() => Promise.resolve(output));
    }
    write(filePath, data, changes) {
        try {
            if (!hasNativeIni) {
                const ops = [];
                changes.removed.forEach((fullKey) => {
                    const [section, key] = fullKey.split('###');
                    if (key !== undefined) {
                        ops.push({ section, key, value: null });
                    }
                });
                [].concat(changes.added, changes.changed)
                    .forEach((fullKey) => {
                    const [section, key] = fullKey.split('###');
                    if (key !== undefined) {
                        ops.push({ section, key, value: String(data[section][key]) });
                    }
                });
                writeIni(filePath, ops);
                return Promise.resolve();
            }
            changes.removed.forEach((fullKey) => {
                const [section, key] = fullKey.split('###');
                winapi.WritePrivateProfileString(section, key, null, filePath);
            });
            [].concat(changes.added, changes.changed)
                .forEach((fullKey) => {
                const [section, key] = fullKey.split('###');
                winapi.WritePrivateProfileString(section, key, data[section][key], filePath);
            });
            return Promise.resolve();
        }
        catch (err) {
            return Promise.reject(err);
        }
    }
    readSectionList(filePath) {
        return Promise.resolve(hasNativeIni
            ? winapi.GetPrivateProfileSectionNames(filePath)
            : Object.keys(parseIni(decodeFile(filePath).text)));
    }
    readSection(filePath, section) {
        if (hasNativeIni) {
            return Promise.resolve(winapi.GetPrivateProfileSection(section, filePath));
        }
        const parsed = parseIni(decodeFile(filePath).text);
        return Promise.resolve(parsed[section] !== undefined ? parsed[section] : {});
    }
}
exports.default = WinapiFormat;
//# sourceMappingURL=WinapiFormat.js.map
