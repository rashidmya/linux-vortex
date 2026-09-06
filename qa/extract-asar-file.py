#!/usr/bin/env python3
"""Extract one file from an Electron asar archive.

Usage: extract-asar-file.py <archive.asar> </path/inside/archive> <destination>
"""
import json
import struct
import sys


def open_asar(path):
    handle = open(path, 'rb')
    header = handle.read(16)
    header_size = struct.unpack('<I', header[12:16])[0]
    tree = json.loads(handle.read(header_size).decode('utf-8'))
    base = 16 + header_size
    base += (4 - base % 4) % 4          # the header is padded to 4 bytes
    return handle, tree, base


def walk(node, prefix, out):
    for name, meta in node.get('files', {}).items():
        path = prefix + '/' + name
        if 'files' in meta:
            walk(meta, path, out)
        else:
            out[path] = meta


def main():
    archive, wanted, dest = sys.argv[1], sys.argv[2], sys.argv[3]
    handle, tree, base = open_asar(archive)
    entries = {}
    walk(tree, '', entries)
    meta = entries[wanted]
    handle.seek(base + int(meta['offset']))
    with open(dest, 'wb') as out:
        out.write(handle.read(int(meta['size'])))


if __name__ == '__main__':
    main()
